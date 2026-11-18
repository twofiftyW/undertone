package personal.undertone.player

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle

/** Keep the player task alive when Android removes a disabled launcher alias. */
class LauncherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}

/** PackageManager persists the selection across process restarts and in-place updates. */
class LauncherIcons(context: Context) {
    private val manager = context.packageManager
    private val aliases = listOf("green", "blue", "amoled", "gray").associateWith {
        ComponentName(context, "${context.packageName}.launcher.$it")
    }

    private fun enabled(id: String): Boolean =
        when (manager.getComponentEnabledSetting(aliases.getValue(id))) {
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> id == "green"
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            else -> false
        }

    @Synchronized fun current(): String {
        val active = aliases.keys.filter(::enabled)
        // Repair the intermediate state left if an older Android process stopped mid-switch.
        return active.singleOrNull() ?: select(active.firstOrNull() ?: "green")
    }

    @Synchronized fun select(id: String): String {
        require(id in aliases)
        val changes = mutableMapOf<ComponentName, Int>()
        // Before Android 13 each change is separate. Always keep one launchable entry.
        if (!enabled(id)) changes[aliases.getValue(id)] = PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        for ((other, alias) in aliases) {
            if (other != id && enabled(other)) changes[alias] = PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }
        if (changes.isEmpty()) return id
        if (Build.VERSION.SDK_INT >= 33) {
            manager.setComponentEnabledSettings(changes.map { (alias, state) ->
                PackageManager.ComponentEnabledSetting(alias, state, PackageManager.DONT_KILL_APP)
            })
        } else {
            changes.forEach { (alias, state) -> manager.setComponentEnabledSetting(alias, state, PackageManager.DONT_KILL_APP) }
        }
        return id
    }
}
