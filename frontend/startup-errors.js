window.addEventListener(
  "error",
  (e) => {
    const p = document.createElement("p");
    p.textContent =
      "界面初始化失败：" +
      (e.message || e.target?.src || "资源加载失败") +
      " " +
      e.filename +
      ":" +
      e.lineno +
      ":" +
      e.colno;
    document.querySelector("#view")?.append(p);
  },
  true,
);
window.addEventListener("unhandledrejection", (e) => {
  const p = document.createElement("p");
  p.textContent = "操作失败：" + String(e.reason);
  document.querySelector("#view")?.append(p);
});
if (/Android/i.test(navigator.userAgent))
  document.documentElement.classList.add("android");
