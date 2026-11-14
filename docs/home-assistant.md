# Home Assistant examples

The bridge exposes an authenticated internal API and sends Vonage events to Home Assistant webhooks. Replace the example hostname and secret with your own configuration.

## REST commands

Add to `configuration.yaml` (or the file containing your `rest_command` configuration):

```yaml
rest_command:
  make_call:
    url: "http://vonage:3000/api/call"
    method: POST
    content_type: "application/json"
    headers:
      x-api-token: !secret vonage_bridge_api_token
    timeout: 45
    payload: >-
      {
        "to": {{ to | tojson }},
        "text": {{ text | tojson }},
        "mode": {{ mode | default('talk') | tojson }}
      }

  send_sms:
    url: "http://vonage:3000/api/send-sms"
    method: POST
    content_type: "application/json"
    headers:
      x-api-token: !secret vonage_bridge_api_token
    payload: >-
      {
        "to": {{ to | tojson }},
        "text": {{ text | tojson }}
      }
```

The example hostname `vonage` assumes HA and the bridge share a Docker network. Use the bridge's actual internal address otherwise. Put the matching `INTERNAL_API_TOKEN` in `secrets.yaml`:

```yaml
vonage_bridge_api_token: your-internal-api-token
```

If `VOICE_WAIT_FOR_RESULT=true` (the default in the example `ebertek-compose` deployment), a call can take up to `VOICE_WAIT_FOR_RESULT_TIMEOUT_S` (default 30 seconds). Set the HA REST command timeout **higher** than that; 45 seconds works for the default wait.

## Check the result of an outbound call

Home Assistant's REST command does not automatically fail an automation for HTTP 502/504. Capture its response and explicitly stop on a non-200 status:

```yaml
- action: rest_command.make_call
  data:
    to: "12025550123"
    text: "Water leak detected!"
  response_variable: vonage_call

- if: "{{ vonage_call.status | int != 200 }}"
  then:
    - stop: "Vonage call failed or its outcome is unknown"
      error: true
```

A 502 indicates a reported call failure, while 504 means no final result arrived before the wait expired. A timed-out call may still complete later; don't blindly retry it.

## Receive asynchronous call failure notifications

Set `HA_BASE_URL` and `HA_LONG_LIVED_TOKEN` on the bridge, then create an HA automation with the webhook ID matching `HA_CALL_EVENT_WEBHOOK_ID` (default: `vonage_call_event`):

```yaml
- alias: "Vonage outbound call failure"
  triggers:
    - trigger: webhook
      webhook_id: vonage_call_event
      allowed_methods:
        - POST
      local_only: true
  conditions:
    - condition: template
      value_template: >-
        {% set call = trigger.json.call_result | default({}) %}
        {{ trigger.json.provider == 'vonage'
           and call.direction == 'outbound'
           and call.outcome in ['failed', 'not_answered'] }}
  actions:
    - action: persistent_notification.create
      data:
        notification_id: "vonage-{{ trigger.json.call_result.uuid }}"
        title: "Vonage call not delivered"
        message: >-
          Status: {{ trigger.json.call_result.status }},
          SIP: {{ trigger.json.call_result.sip_code }},
          detail: {{ trigger.json.call_result.detail }}
```

The stable notification ID helps avoid duplicate notifications when Vonage sends multiple failure-related events for the same call. The webhook's `payload` contains the original Vonage event, and `call_result` contains the normalized outcome.

For SMS delivery receipts, use a second webhook automation with the ID matching `HA_SMS_DLR_WEBHOOK_ID` (default: `vonage_sms_dlr`). The bridge forwards the Messages API status in `trigger.json.payload`.

## Inbound SMS to Assist

With HA credentials configured, incoming SMS messages from permitted senders are sent to Home Assistant Assist; the bridge sends Assist's response back via Vonage SMS. Set `ALLOWED_SMS_SENDERS` to restrict which senders can use this feature.

## Vonage account balance

Track the remaining Vonage credit (EUR) with a Home Assistant REST sensor.
This uses Vonage's [Account API](https://developer.vonage.com/en/api/account) directly, not the bridge.
It requires your **API key and API secret** for HTTP Basic authentication; the
bridge itself does not need the API secret.

Add to `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: Vonage Account Balance
    unique_id: vonage_account_balance
    resource: "https://rest.nexmo.com/account/get-balance"
    authentication: basic
    username: !secret vonage_api_key
    password: !secret vonage_api_secret
    scan_interval: 3600
    device_class: monetary
    state_class: measurement
    unit_of_measurement: "EUR"
    json_attributes:
      - autoReload
    value_template: "{{ value_json.value | float | round(2) }}"
```

Add `vonage_api_key` and `vonage_api_secret` to your Home Assistant
`secrets.yaml`. The example polls hourly; change `scan_interval` if needed.
Use a separate low-balance automation if you want notifications.

