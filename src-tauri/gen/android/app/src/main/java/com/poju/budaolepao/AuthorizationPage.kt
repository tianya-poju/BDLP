package com.poju.budaolepao

import android.app.Dialog
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.TextView
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import java.net.URI

internal class AuthorizationPage(
    private val host: MainActivity,
    val kind: String,
    val id: String,
    private val address: String,
    private val onClosed: (AuthorizationPage, String?) -> Unit
) {
    private val dialog = Dialog(host, android.R.style.Theme_Material_Light_NoActionBar)
    private val web = WebView(host)
    private var callback: String? = null
    private var closed = false
    private var pendingPermission: PermissionRequest? = null
    private var pendingFile: ValueCallback<Array<Uri>>? = null
    private val timer = Handler(Looper.getMainLooper())
    private val status = TextView(host).apply { setPadding(24, 12, 24, 12) }
    private val expiresAt = SystemClock.uptimeMillis() + 570_000
    private val watchUrl = object : Runnable {
        override fun run() {
            if (closed || callback != null) return
            if (SystemClock.uptimeMillis() >= expiresAt) {
                phase = "timeout"
                Log.i("BDLP-QQ", "timeout")
                dismiss()
                return
            }
            if (!acceptQqCallback(web.url.orEmpty(), "current-url")) {
                timer.postDelayed(this, 500)
            }
        }
    }
    var phase = "loading"
        private set

    fun show() {
        val layout = LinearLayout(host).apply { orientation = LinearLayout.VERTICAL }
        layout.addView(Button(host).apply {
            text = if (kind == "qq") "关闭 QQ 授权" else "关闭人脸登记"
            setOnClickListener { dismiss() }
        })
        if (kind == "qq") {
            status.text = "请用另一台设备扫码并在 QQ 中确认"
            layout.addView(status)
        }
        layout.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                acceptQqCallback(request.url.toString(), "navigation") ||
                    request.isForMainFrame && handleNavigation(request.url.toString())

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                if (handleNavigation(url)) view.stopLoading()
                else phase = "loading"
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                acceptQqCallback(url, "history")
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (acceptQqCallback(url, "page-finished")) return
                if (phase == "loading" && allowed(kind, url)) {
                    phase = "loaded"
                    if (kind == "qq") status.text = "请用另一台设备扫码并在 QQ 中确认"
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) pageError()
            }

            override fun onReceivedHttpError(
                view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse
            ) {
                if (request.isForMainFrame) pageError()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                dismiss()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (kind != "face" || !allowed("face", request.origin.toString()) ||
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE !in request.resources ||
                    pendingPermission != null
                ) {
                    request.deny()
                    return
                }
                pendingPermission = request
                host.requestCamera { granted ->
                    if (pendingPermission === request) {
                        pendingPermission = null
                        if (granted && !closed) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                        else request.deny()
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingPermission === request) pendingPermission = null
            }

            override fun onShowFileChooser(
                webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                if (kind != "face" || !allowed("face", webView.url.orEmpty()) || pendingFile != null) return false
                pendingFile = filePathCallback
                try {
                    host.pickImage { uri ->
                        if (pendingFile === filePathCallback) {
                            pendingFile = null
                            filePathCallback.onReceiveValue(uri?.let { arrayOf(it) })
                        }
                    }
                } catch (_: Exception) {
                    pendingFile = null
                    filePathCallback.onReceiveValue(null)
                }
                return true
            }
        }
        dialog.setContentView(layout)
        dialog.setOnDismissListener {
            closed = true
            timer.removeCallbacksAndMessages(null)
            pendingPermission?.deny()
            pendingPermission = null
            pendingFile?.onReceiveValue(null)
            pendingFile = null
            layout.removeView(web)
            web.stopLoading()
            web.destroy()
            onClosed(this, callback)
        }
        dialog.show()
        web.loadUrl(address)
        if (kind == "qq") timer.post(watchUrl)
    }

    fun dismiss() = dialog.dismiss()

    private fun pageError() {
        phase = "failed"
        if (kind == "qq") {
            status.text = "QQ 授权页加载失败，请关闭后重试"
            Log.i("BDLP-QQ", "page-error")
        }
    }

    private fun acceptQqCallback(address: String, source: String): Boolean {
        if (kind != "qq" || !QqCallback.matches(address)) return false
        if (callback == null && !closed) {
            callback = address
            phase = "confirmed"
            status.text = "已确认，正在登录…"
            Log.i("BDLP-QQ", "callback-received/" + source)
            timer.post { dismiss() }
        }
        return true
    }

    private fun handleNavigation(address: String): Boolean {
        if (acceptQqCallback(address, "page-start")) return true
        val blocked = !allowed(kind, address)
        if (blocked) pageError()
        return blocked
    }

    companion object {
        private fun parse(address: String): URI? = try { URI(address) } catch (_: Exception) { null }
        private fun clean(uri: URI) = uri.userInfo == null && uri.port == -1

        fun allowed(kind: String, address: String): Boolean {
            val uri = parse(address.substringBefore('#')) ?: return false
            val host = uri.host ?: return false
            if (uri.scheme != "https" || !clean(uri)) return false
            return when (kind) {
                "qq" -> host == "qq.com" || host.endsWith(".qq.com")
                "face" -> host == "api2.lptiyu.com"
                else -> false
            }
        }
    }
}
