import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The backend URL and token live in local.properties so the token never lands
// in a source file or a commit. See local.properties.example.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun localProp(name: String, fallback: String = "") =
    (localProps.getProperty(name) ?: fallback).trim()

android {
    namespace = "com.dimhold.watchask"
    // Recent Galaxy Watch models report Android 16 / API 36 (Wear OS 6), so
    // target that directly rather than running under compatibility behaviour.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dimhold.watchask"
        // Wear OS 3 and up.
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"

        // 192.0.2.x is the documentation range from RFC 5737. It is a
        // placeholder that cannot accidentally be someone's real machine.
        buildConfigField(
            "String",
            "BACKEND_URL",
            "\"${localProp("backend.url", "http://192.0.2.10:8787")}\""
        )
        buildConfigField("String", "BACKEND_TOKEN", "\"${localProp("backend.token")}\"")
        // Empty means "use the watch's own locale".
        buildConfigField("String", "SPEECH_LANGUAGE", "\"${localProp("speech.language")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
