# 不道乐跑 Android 版

Android 1.1.2 包名为 `com.poju.budaolepao`，适用 Android 8.0 及以上的 ARM64 设备。发布包的内部版本代码为 `1001005`，可覆盖安装同签名的 1.1.3、1.1.4 测试包并保留本地数据。后续发布应递增 Android 的 `versionCode`。早期使用 `cn.lepaopoju.android` 包名的版本可并存，从该版本迁移时需重新登录。

## 安装和使用

把 `BDLP-1.1.2-android-arm64.apk` 传到手机后打开。控制台可选择学校和跑区，设置页可添加或切换账号。「设置 → 关于」可检查更新并前往 GitHub 下载新版。

QQ 登录时，用另一台设备扫描授权页的二维码并在 QQ 中确认。打开路线编辑或历史轨迹时，地图通过高德 JS API 联网加载。

## 高德地图

Android 和 Windows 共用高德 JS API。使用 `-MapConfig` 指定本机地图配置，其中包含 JS API Key、配套安全密钥和 Web 服务 Key。地图配置文件留在仓库外。

## Windows 构建 Android APK

准备 Node.js、Git、Rust、Tauri CLI 2.11、JDK 17、Android SDK Platform 36、Build Tools 35.0.0、NDK 28.2.13676358 和 `aarch64-linux-android` Rust 目标。先运行 `npm ci`，然后在仓库根目录运行以下命令。

```powershell
rustup target add aarch64-linux-android
.\tools\build-android.ps1 -SdkPath 'D:\Android\Sdk' -JdkPath 'D:\Android\tools\jdk-17.0.20.1+1' -MapConfig '..\..\tauri-app\map-secrets.local.json' -CargoTargetDir 'D:\Android\bdlp-target'
```

构建脚本默认把签名 APK 放到 `build/android/`。Cargo 输出目录使用纯 ASCII 路径，脚本会自动暂存中文路径下的构建输入。默认使用 Google Maven，可通过 `BDLP_GOOGLE_MAVEN_URL` 指定镜像。

新包签名保存在当前 Windows 用户的 `.android/bdlp-com-poju-budaolepao/`，配套口令由该用户的 DPAPI 加密。后续版本继续使用此签名。
