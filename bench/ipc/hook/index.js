// A pass-through hook: the bench measures the pattern itself, not a validator.
window.__TAURI_ISOLATION_HOOK__ = (payload) => payload;
