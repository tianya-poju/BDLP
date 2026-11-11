package com.poju.budaolepao

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.concurrent.thread

internal class AndroidPhotos(private val host: MainActivity) {
    private val directory = File(host.cacheDir, "photos")
    private var selecting = false

    fun select(invoke: Invoke) {
        if (selecting) {
            invoke.reject("已打开照片选择")
            return
        }
        selecting = true
        if (invoke.getArgs().getBoolean("camera")) {
            host.requestCamera { granted ->
                if (granted) takePhoto(invoke)
                else complete(invoke, null)
            }
        } else {
            try {
                host.pickImage { uri -> complete(invoke, uri) }
            } catch (_: Exception) {
                failed(invoke)
            }
        }
    }

    private fun takePhoto(invoke: Invoke) {
        var temporary: File? = null
        try {
            check(directory.isDirectory || directory.mkdirs())
            val expiration = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
            directory.listFiles()?.filter { it.name.startsWith("capture-") && it.lastModified() < expiration }
                ?.forEach { it.delete() }
            val file = File.createTempFile("capture-", ".jpg", directory)
            temporary = file
            val uri = FileProvider.getUriForFile(host, host.packageName + ".fileprovider", file)
            host.takePicture(uri) { saved -> complete(invoke, if (saved) uri else null, file) }
        } catch (_: Exception) {
            temporary?.delete()
            failed(invoke)
        }
    }

    private fun complete(invoke: Invoke, uri: Uri?, temporary: File? = null) {
        if (uri == null) {
            temporary?.delete()
            selecting = false
            invoke.resolve(JSObject())
            return
        }
        thread(name = "bdlp-photo-reader") {
            val result = try {
                val bytes = readPhoto(uri)
                "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
            } catch (_: Exception) {
                null
            } finally {
                temporary?.delete()
            }
            host.runOnUiThread {
                if (result == null) failed(invoke)
                else {
                    selecting = false
                    invoke.resolve(JSObject().put("image", result))
                }
            }
        }
    }

    private fun failed(invoke: Invoke) {
        selecting = false
        invoke.reject("无法读取照片")
    }

    private fun readPhoto(uri: Uri): ByteArray {
        val resolver = host.contentResolver
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) }
        require(options.outWidth > 0 && options.outHeight > 0)
        val longest = maxOf(options.outWidth, options.outHeight)
        options.inSampleSize = 1
        while (longest / options.inSampleSize > 2048) options.inSampleSize *= 2
        options.inJustDecodeBounds = false
        val bitmap = requireNotNull(resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) })
        val orientation = try {
            resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            }
        } catch (_: java.io.IOException) {
            null
        }
        val transform = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, transform, true)
        return try {
            ByteArrayOutputStream().apply {
                check(rotated.compress(Bitmap.CompressFormat.JPEG, 94, this))
            }.toByteArray()
        } finally {
            if (rotated !== bitmap) rotated.recycle()
            bitmap.recycle()
        }
    }
}
