plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}
android {
    namespace = "personal.undertone.player"
    compileSdk = 35
    defaultConfig {
        applicationId = "personal.undertone.player"
        minSdk = 26
        targetSdk = 35
        versionCode = 18
        versionName = "0.0.7-alpha"
        testInstrumentationRunner = "personal.undertone.player.EngineInstrumentation"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    sourceSets.getByName("main").assets.srcDir("../../web")
    sourceSets.getByName("main").res.srcDir("../../src-tauri/icons/android")
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes { release { isMinifyEnabled = false } }
}
chaquopy {
    defaultConfig {
        version = "3.14"
        buildPython("python3.14")
        pip {
            install("requests==2.34.2")
            install("yt-dlp==2026.10.26")
        }
    }
    sourceSets.getByName("main") {
        srcDir("../../music")
        exclude("vendor/**", "__pycache__/**")
    }
}
dependencies { implementation("androidx.webkit:webkit:1.13.0") }
