package app.sharecapsule.trackeverything.health

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContract
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.ZoneId

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var statusText: TextView
    private lateinit var connectButton: Button
    private lateinit var syncButton: Button
    private var healthClient: HealthConnectClient? = null

    private val readStepsPermission = HealthPermission.getReadPermission(StepsRecord::class)

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        val connected = granted.contains(readStepsPermission)
        syncButton.isEnabled = connected
        statusText.text = if (connected) {
            "Health Connect is linked. Sign in below, then tap Sync Steps."
        } else {
            "Step access was not granted. You can enable it in Health Connect settings."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        statusText = findViewById(R.id.statusText)
        connectButton = findViewById(R.id.connectButton)
        syncButton = findViewById(R.id.syncButton)

        configureWebView()
        initializeHealthConnect()

        connectButton.setOnClickListener { requestStepPermission() }
        syncButton.setOnClickListener { syncTodaySteps() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (url.startsWith(WEB_APP_URL)) {
                    statusText.text = "Sign in is ready. Connect Health and sync today’s steps."
                }
            }
        }
        webView.loadUrl(WEB_APP_URL)
    }

    private fun initializeHealthConnect() {
        when (HealthConnectClient.getSdkStatus(this, HEALTH_CONNECT_PROVIDER)) {
            HealthConnectClient.SDK_AVAILABLE -> {
                healthClient = HealthConnectClient.getOrCreate(this)
                lifecycleScope.launch {
                    val granted = healthClient?.permissionController?.getGrantedPermissions().orEmpty()
                    syncButton.isEnabled = granted.contains(readStepsPermission)
                }
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                statusText.text = "Install or update Health Connect, then reopen this app."
                connectButton.isEnabled = false
            }
            else -> {
                statusText.text = "Health Connect is unavailable on this device."
                connectButton.isEnabled = false
            }
        }
    }

    private fun requestStepPermission() {
        if (healthClient == null) return
        permissionLauncher.launch(setOf(readStepsPermission))
    }

    private fun syncTodaySteps() {
        val client = healthClient ?: return
        syncButton.isEnabled = false
        statusText.text = "Reading today’s steps…"

        lifecycleScope.launch {
            try {
                val zone = ZoneId.systemDefault()
                val date = LocalDate.now(zone)
                val start = date.atStartOfDay(zone).toInstant()
                val end = date.plusDays(1).atStartOfDay(zone).toInstant()
                val response = client.aggregate(
                    AggregateRequest(
                        metrics = setOf(StepsRecord.COUNT_TOTAL),
                        timeRangeFilter = TimeRangeFilter.between(start, end)
                    )
                )
                val steps = response[StepsRecord.COUNT_TOTAL] ?: 0L
                readSessionToken { token ->
                    if (token.isNullOrBlank()) {
                        runOnUiThread {
                            statusText.text = "Sign in to Track Everything in the page below before syncing."
                            syncButton.isEnabled = true
                        }
                    } else {
                        lifecycleScope.launch { uploadSteps(token, date.toString(), steps) }
                    }
                }
            } catch (error: Exception) {
                statusText.text = "Unable to read steps: ${error.message ?: "unknown error"}"
                syncButton.isEnabled = true
            }
        }
    }

    private fun readSessionToken(callback: (String?) -> Unit) {
        webView.evaluateJavascript(
            "sessionStorage.getItem('trackEverythingSession')"
        ) { value ->
            val token = if (value == null || value == "null") null else value.trim('"').replace("\\\"", "\"")
            callback(token)
        }
    }

    private suspend fun uploadSteps(token: String, date: String, steps: Long) {
        try {
            withContext(Dispatchers.IO) {
                val connection = URL("$API_URL/api/steps").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000

                val payload = JSONObject()
                    .put("eventId", "health-connect:$date")
                    .put("date", date)
                    .put("steps", steps)
                    .put("source", "android-health-connect")
                    .toString()

                connection.outputStream.use { it.write(payload.toByteArray()) }
                val responseCode = connection.responseCode
                val responseText = (if (responseCode in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() }.orEmpty()

                if (responseCode !in 200..299) {
                    val message = runCatching { JSONObject(responseText).optString("error") }.getOrNull()
                    throw IllegalStateException(message?.takeIf { it.isNotBlank() } ?: "Server returned $responseCode")
                }
            }
            statusText.text = "Synced $steps steps for $date."
            webView.reload()
        } catch (error: Exception) {
            statusText.text = "Step sync failed: ${error.message ?: "unknown error"}"
        } finally {
            syncButton.isEnabled = true
        }
    }

    companion object {
        private const val WEB_APP_URL = "https://trackeverything.sharecapsule.app/"
        private const val API_URL = "https://track-everything-api-854374277452.us-west1.run.app"
        private const val HEALTH_CONNECT_PROVIDER = "com.google.android.apps.healthdata"
    }
}
