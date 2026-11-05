package expo.modules.tvremote

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import java.util.Locale

/**
 * The installed version and where it came from, plus Google Play's in-app updates
 * (com.google.android.play:app-update 2.1.0, per developer.android.com/guide/playcore/in-app-updates).
 * Play only answers for apps installed from Google Play (otherwise the info task fails with
 * APP_NOT_OWNED), so JavaScript asks it only when the installer is com.android.vending.
 * The update is IMMEDIATE: Play shows its own full-screen download and restarts the app.
 */
object PlayUpdates {
  /** Set once this process opened Play's update screen, so a stalled update is resumed on return. */
  @Volatile private var started = false

  fun appInfo(context: Context): Map<String, Any?> {
    val pm = context.packageManager
    val pkg = context.packageName
    val info =
      if (Build.VERSION.SDK_INT >= 33) {
        pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(pkg, 0)
      }
    val build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    val installer =
      try {
        if (Build.VERSION.SDK_INT >= 30) {
          pm.getInstallSourceInfo(pkg).installingPackageName
        } else {
          @Suppress("DEPRECATION")
          pm.getInstallerPackageName(pkg)
        }
      } catch (e: Exception) {
        null
      }
    return mapOf(
      "version" to (info.versionName ?: ""),
      "build" to build.toString(),
      "installer" to installer,
      "region" to Locale.getDefault().country.ifEmpty { null },
    )
  }

  fun check(context: Context, done: (Map<String, Any>) -> Unit, fail: (Exception) -> Unit) {
    AppUpdateManagerFactory.create(context).appUpdateInfo
      .addOnSuccessListener { info ->
        val available =
          info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE &&
            info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)
        done(mapOf("available" to available, "versionCode" to if (available) info.availableVersionCode() else 0))
      }
      .addOnFailureListener { fail(it) }
  }

  /**
   * Opens Play's update screen with a fresh AppUpdateInfo (each one can start a single flow).
   * `startUpdateFlow` takes the Activity and returns a Task, so no onActivityResult is needed; its
   * result is the screen's result code (Activity.RESULT_OK, RESULT_CANCELED or
   * ActivityResult.RESULT_IN_APP_UPDATE_FAILED).
   */
  fun start(context: Context, activity: Activity, done: (Int) -> Unit, fail: (Exception) -> Unit) {
    val manager = AppUpdateManagerFactory.create(context)
    manager.appUpdateInfo
      .addOnSuccessListener { info ->
        val state = info.updateAvailability()
        if (state != UpdateAvailability.UPDATE_AVAILABLE && state != UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
          fail(IllegalStateException("no update available"))
          return@addOnSuccessListener
        }
        started = true
        manager.startUpdateFlow(info, activity, AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build())
          .addOnSuccessListener { code -> done(code ?: Activity.RESULT_CANCELED) }
          .addOnFailureListener { fail(it) }
      }
      .addOnFailureListener { fail(it) }
  }

  /** The guide: when an immediate update is stuck in DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS on return, resume it. */
  fun resumeIfStalled(context: Context, activity: Activity?) {
    if (!started || activity == null) return
    val manager = AppUpdateManagerFactory.create(context)
    manager.appUpdateInfo.addOnSuccessListener { info ->
      if (info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
        manager.startUpdateFlow(info, activity, AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build())
      }
    }
  }
}
