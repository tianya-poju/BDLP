package com.poju.budaolepao

import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

class MainActivity : TauriActivity() {
    private var mainView: WebView? = null
    private var startupReady = false
    private var removeSplash: (() -> Unit)? = null
    private val startupTimeout = Runnable { completeStartup() }
    private var photoResult: ((Uri?) -> Unit)? = null
    private var captureResult: ((Boolean) -> Unit)? = null
    private var permissionResult: ((Boolean) -> Unit)? = null
    private val picker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val callback = photoResult
        photoResult = null
        callback?.invoke(uri)
    }
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val callback = captureResult
        captureResult = null
        callback?.invoke(saved)
    }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val callback = permissionResult
        permissionResult = null
        callback?.invoke(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            splashScreen.setOnExitAnimationListener { splash ->
                if (startupReady) splash.remove() else removeSplash = splash::remove
            }
            window.decorView.postDelayed(startupTimeout, 4_500L)
        }
        val content = findViewById<android.view.View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.updatePadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = mainView
                if (view == null) {
                    moveTaskToBack(true)
                    return
                }
                view.evaluateJavascript("Boolean(window.bdlpAndroidBack?.())") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        webView.setBackgroundColor(getColor(R.color.startup_background))
        mainView = webView
    }

    internal fun firstPageReady() {
        val view = mainView ?: return
        if (startupReady || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        // Reveal the WebView once Chromium can draw the DOM sent by the first screen.
        view.postVisualStateCallback(0L, object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) = completeStartup()
        })
    }

    private fun completeStartup() {
        startupReady = true
        window.decorView.removeCallbacks(startupTimeout)
        removeSplash?.invoke()
        removeSplash = null
    }

    override fun onDestroy() {
        completeStartup()
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        mainView?.evaluateJavascript("window.dispatchEvent(new Event('bdlp-android-resume'))", null)
    }

    fun pickImage(result: (Uri?) -> Unit) {
        check(photoResult == null) { "照片选择器已打开" }
        photoResult = result
        try {
            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        } catch (error: Exception) {
            photoResult = null
            throw error
        }
    }

    fun takePicture(uri: Uri, result: (Boolean) -> Unit) {
        check(captureResult == null) { "相机已打开" }
        captureResult = result
        try {
            camera.launch(uri)
        } catch (error: Exception) {
            captureResult = null
            throw error
        }
    }

    fun requestCamera(result: (Boolean) -> Unit) {
        if (permissionResult != null) {
            result(false)
            return
        }
        permissionResult = result
        try {
            permission.launch(android.Manifest.permission.CAMERA)
        } catch (_: Exception) {
            permissionResult = null
            result(false)
        }
    }
}
