buildscript {
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
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
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
}

tasks.register("clean").configure {
    delete("build")
}
