import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";

// Login screen. Posts {token, actor} to /api/v1/auth/session — on 200
// we navigate to the next URL (or `/`) via a hard window.location swap
// so the dashboard reloads with the cookie attached. The form opts out
// of the global 401-redirect via api.login()'s suppressAuthRedirect so
// a wrong token shows inline instead of bouncing back to itself.

export function LoginScreen() {
  const [actor, setActor] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const login = useMutation({
    mutationFn: () => api.login(token, actor.trim() || "user"),
    onSuccess: () => {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      const dest = next && next.startsWith("/") ? next : "/";
      window.location.assign(dest);
    },
  });

  const errorMsg =
    login.error instanceof ApiError
      ? login.error.status === 401
        ? "wrong token"
        : login.error.message
      : login.error
        ? "login failed"
        : null;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-ink-900">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!token) return;
          login.mutate();
        }}
        className="w-full max-w-sm space-y-5 rounded border border-ink-700 bg-ink-800 p-5"
      >
        <div>
          <h1 className="font-mono font-semibold text-base text-ink-100">mill</h1>
          <p className="text-xs text-ink-300 mt-1">sign in</p>
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wide text-ink-300">
            actor
          </span>
          <input
            type="text"
            autoComplete="username"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="your name (audit trail)"
            className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-ink-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wide text-ink-300 flex items-baseline justify-between">
            token
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="text-[10px] normal-case tracking-normal text-ink-300 hover:text-ink-100"
            >
              {showToken ? "hide" : "show"}
            </button>
          </span>
          <input
            type={showToken ? "text" : "password"}
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="MILL_AUTH_TOKEN"
            className="w-full rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-ink-500"
            autoFocus
          />
        </label>

        <button
          type="submit"
          disabled={login.isPending || !token}
          className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 disabled:text-ink-300 px-3 py-1.5 font-mono text-sm"
        >
          {login.isPending ? "signing in…" : "sign in"}
        </button>

        {errorMsg ? (
          <div className="rounded border border-rose-700 bg-rose-950/40 px-2 py-1.5 text-xs text-rose-200 font-mono">
            {errorMsg}
          </div>
        ) : null}

        <p className="text-[11px] text-ink-300 leading-relaxed">
          set <code className="bg-ink-700 px-1 rounded">MILL_AUTH_TOKEN</code>{" "}
          via <code className="bg-ink-700 px-1 rounded">mill auth init</code>{" "}
          on the daemon host. on a single-user laptop with no token set, the
          UI loads without sign-in.
        </p>
      </form>
    </div>
  );
}
