package com.poju.budaolepao

import java.net.URI

internal object QqCallback {
    private val credentials = Regex("""(?:^|[&#])(?:access_token|openid)=""")

    fun matches(address: String): Boolean {
        if (address.length > 24_000 || address.any(Char::isISOControl)) return false
        val uri = try { URI(address.substringBefore('#')) } catch (_: Exception) { return false }
        if (uri.userInfo != null || uri.port != -1) return false
        val allowed = when (uri.scheme) {
            "auth" -> uri.host == "tauth.qq.com" && (uri.path.isNullOrEmpty() || uri.path == "/")
            "https" -> uri.host == "imgcache.qq.com" &&
                uri.path == "/open/connect/widget/mobile/login/proxy.htm"
            else -> false
        }
        if (!allowed) return false
        val fragment = address.substringAfter('#', "")
        return credentials.containsMatchIn(uri.rawQuery.orEmpty()) ||
            credentials.containsMatchIn(fragment)
    }
}
