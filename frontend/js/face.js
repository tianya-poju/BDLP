/* 人脸照片处理（浏览器端）：归一化 / 随机化扰动 / 摄像头拍摄 / 内容指纹
 *
 * 为什么放在浏览器端：服务端零依赖，不做图像重编码；
 * Canvas 天然具备解码→变换→重编码能力，正好承载官方的 randomizeFaceImage 等价流程。
 */
'use strict';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

/** SHA-256 十六进制指纹（用于内容去重） */
export async function fingerprint(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 归一化：最长边 ≤1024 + JPEG 92，抹掉 EXIF 与原始压缩参数
 * @param {File|Blob|string} source 文件或 dataURL
 * @returns {Promise<{blob:Blob, dataUrl:string, fingerprint:string}>}
 */
export async function normalizePhoto(source, maxEdge = 1024, quality = 0.92) {
  const src = typeof source === 'string' ? source : URL.createObjectURL(source);
  const img = await loadImage(src);
  if (typeof source !== 'string') URL.revokeObjectURL(src);
  const scale = Math.min(maxEdge / Math.max(img.width, img.height), 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(Math.round(img.width * scale), 1);
  canvas.height = Math.max(Math.round(img.height * scale), 1);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, dataUrl: await blobToDataUrl(blob), fingerprint: await fingerprint(blob) };
}

/**
 * 随机化扰动（对齐官方 randomizeFaceImage）：
 * 内缩裁剪 0~4% → 旋转 ±3°（放大盖边）→ 亮度/对比度 ±8% → 尺寸 720~1024 → JPEG 78~95
 * 目标：打散字节 hash 与感知 hash，同时不影响人脸比对
 */
export async function randomizePhoto(source) {
  const src = typeof source === 'string' ? source : URL.createObjectURL(source);
  const img = await loadImage(src);
  if (typeof source !== 'string') URL.revokeObjectURL(src);

  const rnd = (a, b) => a + Math.random() * (b - a);
  const insW = Math.round(img.width * rnd(0, 0.04));
  const insH = Math.round(img.height * rnd(0, 0.04));
  const cw = Math.max(img.width - insW * 2, 64);
  const ch = Math.max(img.height - insH * 2, 64);
  const rotate = rnd(-3, 3);
  const cover = 1 + Math.abs(rotate) / 25;
  const contrast = 1 + (Math.random() - 0.5) * 0.16;
  const brightness = (Math.random() - 0.5) * 24;
  const longest = Math.max(cw, ch);
  const target = Math.round(rnd(720, 1024));
  const scale = target / longest;

  const outW = Math.max(Math.round(cw * scale * cover), 64);
  const outH = Math.max(Math.round(ch * scale * cover), 64);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.scale(scale * cover, scale * cover);
  ctx.filter = `contrast(${contrast.toFixed(3)}) brightness(${(1 + brightness / 255).toFixed(3)})`;
  ctx.drawImage(img, insW, insH, cw, ch, -cw / 2, -ch / 2, cw, ch);
  ctx.restore();

  const blob = await canvasToBlob(canvas, rnd(0.78, 0.95));
  return { blob, dataUrl: await blobToDataUrl(blob), fingerprint: await fingerprint(blob) };
}

/** 通过文件选择器取图 */
export function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

/**
 * 摄像头拍照（getUserMedia）—— Web 端替代「重拍替换」的相机入口
 * 单机场景：手机可直接用前置摄像头自拍，比 Android 端从相册选更顺手
 * @returns {Promise<Blob|null>}
 */
export function captureFromCamera() {
  return new Promise(async (resolve) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      resolve(null);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } } });
    } catch (_) {
      resolve(null);
      return;
    }
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    video.style.cssText = 'width:100%;border-radius:10px;background:#000';

    const canvas = document.createElement('canvas');
    const shot = document.createElement('button');
    shot.className = 'btn btn-primary btn-block';
    shot.textContent = '拍照';

    const box = document.createElement('div');
    box.className = 'col';
    box.append(video, shot);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.maxWidth = '520px';
    modal.innerHTML = '<div class="modal-head"><h3>拍摄人脸照片</h3></div>';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    bodyEl.appendChild(box);
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.textContent = '取消';
    foot.appendChild(cancel);
    modal.append(bodyEl, foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const stop = () => {
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      document.body.style.overflow = '';
    };
    cancel.onclick = () => { stop(); resolve(null); };
    shot.onclick = async () => {
      canvas.width = video.videoWidth || 720;
      canvas.height = video.videoHeight || 960;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, 0.95);
      stop();
      resolve(blob);
    };
    document.body.style.overflow = 'hidden';
  });
}