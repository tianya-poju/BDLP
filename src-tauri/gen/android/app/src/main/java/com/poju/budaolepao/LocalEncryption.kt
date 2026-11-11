package com.poju.budaolepao

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object LocalEncryption {
    private const val alias = "bdlp-local-v1"
    private const val nonceSize = 12

    @Synchronized
    fun protect(input: ByteArray, decrypt: Boolean): ByteArray {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey(alias, null) as? SecretKey ?: run {
            check(!decrypt) { "找不到 Android 本机加密密钥" }
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(
                    KeyGenParameterSpec.Builder(
                        alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                    ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build()
                )
            }.generateKey()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        if (decrypt) {
            require(input.size >= 1 + nonceSize + 16 && input[0] == 1.toByte())
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, input, 1, nonceSize))
            return cipher.doFinal(input, 1 + nonceSize, input.size - 1 - nonceSize)
        }
        cipher.init(Cipher.ENCRYPT_MODE, key)
        check(cipher.iv.size == nonceSize)
        return byteArrayOf(1) + cipher.iv + cipher.doFinal(input)
    }
}
