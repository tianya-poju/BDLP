[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SdkPath,
    [Parameter(Mandatory)][string]$JdkPath,
    [Parameter(Mandatory)][string]$MapConfig,
    [string]$CargoTargetDir = "$env:LOCALAPPDATA\BDLP\cargo-android",
    [string]$SigningDirectory = "$env:USERPROFILE\.android\bdlp-com-poju-budaolepao",
    [string]$OutputDirectory,
    [string]$UnsignedApk
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repository 'build\android' }
$env:JAVA_HOME = (Resolve-Path -LiteralPath $JdkPath).Path
$env:ANDROID_HOME = (Resolve-Path -LiteralPath $SdkPath).Path
$env:NDK_HOME = (Resolve-Path -LiteralPath (Join-Path $SdkPath 'ndk\28.2.13676358')).Path
$env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($CargoTargetDir)
$baseTargetDir = $env:CARGO_TARGET_DIR
$env:BUD_MAP_CONFIG_PATH = (Resolve-Path -LiteralPath $MapConfig).Path
$buildTools = (Resolve-Path -LiteralPath (Join-Path $SdkPath 'build-tools\35.0.0')).Path
if ($env:CARGO_TARGET_DIR -cmatch '[^\x00-\x7f]') {
    throw 'Use an ASCII-only Cargo target directory for the Windows NDK linker.'
}

$buildParent = Split-Path -Parent $env:CARGO_TARGET_DIR
New-Item -ItemType Directory -Force -Path $buildParent | Out-Null
$workspace = $repository
$sourceStage = $null
$stage = Join-Path $buildParent ("bdlp-sign-" + [guid]::NewGuid())
$stagedApk = "$stage.unsigned.apk"
$aligned = "$stage.aligned.apk"
$signed = "$stage.signed.apk"
$previousPassword = $env:BDLP_KEYSTORE_PASS
$previousGradleOptions = $env:GRADLE_OPTS
try {
    if (!$UnsignedApk) {
        if ($repository -cmatch '[^\x00-\x7f]') {
            $sourceStage = Join-Path $buildParent ("bdlp-source-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $sourceStage | Out-Null
            $files = git -C $repository -c core.quotepath=false ls-files --cached --others --exclude-standard -- frontend src-tauri tools/build-frontend.cjs package.json package-lock.json
            if ($LASTEXITCODE -ne 0) { throw 'Unable to list project build inputs.' }
            foreach ($file in ($files | Select-Object -Unique)) {
                $source = Join-Path $repository $file
                if (!(Test-Path -LiteralPath $source -PathType Leaf)) { continue }
                $destination = Join-Path $sourceStage $file
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                Copy-Item -LiteralPath $source -Destination $destination
            }
            $modules = (Resolve-Path -LiteralPath (Join-Path $repository 'node_modules')).Path
            New-Item -ItemType Junction -Path (Join-Path $sourceStage 'node_modules') -Target $modules | Out-Null
            $workspace = $sourceStage
            # Tauri writes Kotlin files into this Gradle project from Cargo's build scripts.
            $env:CARGO_TARGET_DIR = Join-Path $sourceStage 'cargo-target'
            $env:GRADLE_OPTS = "$previousGradleOptions -Dorg.gradle.daemon=false".Trim()
        }
        Push-Location -LiteralPath $workspace
        try {
            cargo tauri android build --apk --target aarch64 --ci
            if ($LASTEXITCODE -ne 0) { throw 'Android build failed.' }
        } finally {
            Pop-Location
        }
        $apkDirectory = Join-Path $workspace 'src-tauri\gen\android\app\build\outputs\apk'
        $unsigned = @(Get-ChildItem -LiteralPath $apkDirectory -Recurse -File -Filter '*release-unsigned.apk')
        if ($unsigned.Count -ne 1) { throw 'Pass the release APK path with -UnsignedApk.' }
        $UnsignedApk = $unsigned[0].FullName
    }

    $inputApk = (Resolve-Path -LiteralPath $UnsignedApk).Path
    Copy-Item -LiteralPath $inputApk -Destination $stagedApk
    $manifest = & (Join-Path $buildTools 'aapt.exe') dump badging $stagedApk
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read APK manifest.' }
    $package = $manifest | Select-String -CaseSensitive "^package: name='com\.poju\.budaolepao'.* versionName='([^']+)'"
    $abi = $manifest | Select-String "^native-code: 'arm64-v8a'\s*$"
    $minSdk = $manifest | Select-String "^sdkVersion:'26'\s*$"
    if (!$package -or !$abi -or !$minSdk) { throw 'Expected the ARM64 Android 8+ BDLP release.' }
    $version = $package.Matches[0].Groups[1].Value
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Unexpected release version.' }

    New-Item -ItemType Directory -Force -Path $SigningDirectory, $OutputDirectory | Out-Null
    $keystore = Join-Path $SigningDirectory 'bdlp-release.p12'
    $passwordFile = Join-Path $SigningDirectory 'bdlp-release.dpapi'
    $apk = Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path "BDLP-$version-android-arm64.apk"
    if (!(Test-Path -LiteralPath $keystore) -and !(Test-Path -LiteralPath $passwordFile)) {
        $random = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($random) } finally { $generator.Dispose() }
        $env:BDLP_KEYSTORE_PASS = [Convert]::ToBase64String($random)
        $keyArguments = @('-genkeypair', '-keystore', $keystore, '-storetype', 'PKCS12', '-storepass:env',
            'BDLP_KEYSTORE_PASS', '-alias', 'bdlp', '-keyalg', 'RSA', '-keysize', '3072',
            '-validity', '10000', '-dname', 'CN=#0C08F09F87A8F09F87B3,OU=#0C08F09F87A8F09F87B3,O=#0C08F09F87A8F09F87B3,L=#0C08F09F87A8F09F87B3,ST=#0C08F09F87A8F09F87B3,C=CN')
        & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') @keyArguments
        if ($LASTEXITCODE -ne 0) { throw 'Unable to create the local signing key.' }
        ConvertTo-SecureString $env:BDLP_KEYSTORE_PASS -AsPlainText -Force |
            ConvertFrom-SecureString | Set-Content -LiteralPath $passwordFile -Encoding ascii
    } elseif ((Test-Path -LiteralPath $keystore) -and (Test-Path -LiteralPath $passwordFile)) {
        $secret = Get-Content -LiteralPath $passwordFile | ConvertTo-SecureString
        $env:BDLP_KEYSTORE_PASS = [System.Net.NetworkCredential]::new('', $secret).Password
    } else {
        throw 'Restore the existing keystore and its DPAPI password file as a pair.'
    }

    & (Join-Path $buildTools 'zipalign.exe') -P 16 -f 4 $stagedApk $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
    & (Join-Path $buildTools 'apksigner.bat') sign --ks $keystore --ks-key-alias bdlp --ks-pass env:BDLP_KEYSTORE_PASS --out $signed $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & (Join-Path $buildTools 'apksigner.bat') verify --verbose $signed
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    & (Join-Path $buildTools 'zipalign.exe') -c -P 16 4 $signed
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment verification failed.' }
    Move-Item -LiteralPath $signed -Destination $apk -Force
    Get-FileHash -LiteralPath $apk -Algorithm SHA256
} finally {
    $env:BDLP_KEYSTORE_PASS = $previousPassword
    $env:CARGO_TARGET_DIR = $baseTargetDir
    $env:GRADLE_OPTS = $previousGradleOptions
    foreach ($temporary in @($stagedApk, $aligned, $signed, "$signed.idsig")) {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
    if ($sourceStage -and (Test-Path -LiteralPath $sourceStage)) {
        $resolvedStage = (Resolve-Path -LiteralPath $sourceStage).Path
        if ((Split-Path -Parent $resolvedStage) -eq (Resolve-Path -LiteralPath $buildParent).Path -and
            (Split-Path -Leaf $resolvedStage) -match '^bdlp-source-[0-9a-f-]{36}$') {
            $junction = Join-Path $resolvedStage 'node_modules'
            if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
            for ($attempt = 1; $attempt -le 4; $attempt++) {
                try {
                    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
                    break
                } catch {
                    if ($attempt -eq 4) {
                        Write-Warning "Build staging files remain at $resolvedStage. $($_.Exception.Message)"
                    } else {
                        Start-Sleep -Milliseconds 500
                    }
                }
            }
        }
    }
}
