plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        create("pluginsForCoolKids") {
            id = "rust"
            implementationClass = "RustPlugin"
        }
    }
}

repositories {
    val mirror = System.getenv("BDLP_GOOGLE_MAVEN_URL")
    if (mirror.isNullOrBlank()) google()
    else maven {
        url = uri(mirror)
        content {
            includeGroupByRegex("""com\.android(\..+)?""")
            includeGroupByRegex("""androidx\..+""")
            includeGroupByRegex("""com\.google\.(android|testing|firebase)(\..+)?""")
        }
    }
    mavenCentral()
}

dependencies {
    compileOnly(gradleApi())
    implementation("com.android.tools.build:gradle:8.11.0")
}
