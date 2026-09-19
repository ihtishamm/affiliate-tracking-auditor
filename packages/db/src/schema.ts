// Tables arrive one module at a time (PROJECT_CONTEXT §6). Planned:
//   M3: postback_events, shopify_webhook_events, capi_events
//   M4: runs, run_traces
//   M5: check_results
//   M7: reconciliations
//   M8: funnels, funnel_scores, alerts
// Everything except run_traces (7-day TTL, §8) is append-only.
export {};
