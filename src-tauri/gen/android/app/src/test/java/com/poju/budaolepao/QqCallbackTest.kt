package com.poju.budaolepao

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QqCallbackTest {
    @Test
    fun acceptsKnownFragmentAndCustomSchemeCallbacks() {
        assertTrue(QqCallback.matches("https://imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm?#&t=1#&openid=demo&access_token=synthetic"))
        assertTrue(QqCallback.matches("auth://tauth.qq.com/#openid=demo&access_token=synthetic"))
        assertTrue(QqCallback.matches("auth://tauth.qq.com#openid=demo&access_token=synthetic"))
    }

    @Test
    fun rejectsIntermediateAndUntrustedUrls() {
        for (url in listOf(
            "https://imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm#wait",
            "https://imgcache.qq.com.invalid/open/connect/widget/mobile/login/proxy.htm#openid=demo",
            "https://user@imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm#openid=demo",
            "https://imgcache.qq.com:444/open/connect/widget/mobile/login/proxy.htm#openid=demo",
            "https://imgcache.qq.com/other#access_token=synthetic",
            "http://imgcache.qq.com/open/connect/widget/mobile/login/proxy.htm#openid=demo",
            "auth://tauth.qq.com/other#openid=demo",
        )) assertFalse(QqCallback.matches(url))
    }
}
