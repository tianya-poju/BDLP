package com.poju.budaolepao

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.net.URI

@Keep
@TauriPlugin
class AndroidBridge(activity: Activity) : Plugin(activity) {
    private val host = activity as MainActivity
    private val photos = AndroidPhotos(host)
    private var page: AuthorizationPage? = null

    @Command
    fun firstPageReady(invoke: Invoke) {
        host.firstPageReady()
        invoke.resolve()
    }

    @Command
    fun openUpdatePage(invoke: Invoke) {
        try {
            val url = Uri.parse(invoke.getArgs().getString("url"))
            host.startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法打开系统浏览器")
        }
    }

    @Command
    fun protect(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val bytes = Base64.decode(args.getString("bytes"), Base64.NO_WRAP)
            val protected = LocalEncryption.protect(bytes, args.getBoolean("decrypt"))
            invoke.resolve(JSObject().put("bytes", Base64.encodeToString(protected, Base64.NO_WRAP)))
        } catch (_: Exception) {
            invoke.reject("无法处理本机加密数据")
        }
    }

    @Command
    fun openAlipay(invoke: Invoke) {
        try {
            val raw = invoke.getArgs().getString("url")
            val uri = URI(raw)
            require(uri.scheme == "alipays" && uri.host == "platformapi" &&
                uri.path == "/startapp" && uri.userInfo == null && uri.port == -1)
            host.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw)).setPackage("com.eg.android.AlipayGphone"))
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法打开支付宝")
        }
    }

    @Command
    fun selectPhoto(invoke: Invoke) {
        photos.select(invoke)
    }

    @Command
    fun openAuthorization(invoke: Invoke) {
        openPage("qq", invoke)
    }

    @Command
    fun openRegistration(invoke: Invoke) {
        openPage("face", invoke)
    }

    private fun openPage(kind: String, invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val id = args.getString("id")
            val url = args.getString("url")
            require(AuthorizationPage.allowed(kind, url))
            page?.dismiss()
            page = AuthorizationPage(host, kind, id, url) { closed, callback ->
                if (page === closed) page = null
                if (kind == "qq") {
                    val result = JSObject().put("phase", closed.phase)
                    if (callback != null) result.put("callback", callback)
                    invoke.resolve(result)
                }
            }.also { it.show() }
            if (kind == "face") invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法打开授权页面")
        }
    }

    @Command
    fun registrationStatus(invoke: Invoke) {
        val id = invoke.getArgs().getString("id")
        val phase = page?.takeIf { it.kind == "face" && it.id == id }?.phase ?: "closed"
        invoke.resolve(JSObject().put("phase", phase))
    }

    @Command
    fun closePage(invoke: Invoke) {
        val args = invoke.getArgs()
        page?.takeIf { it.kind == args.getString("kind") && it.id == args.getString("id") }?.dismiss()
        invoke.resolve()
    }
}
