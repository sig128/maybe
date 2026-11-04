import { isRouteErrorResponse, useRouteError } from "react-router";

export function RouteError() {
  const err = useRouteError();
  const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : "Unknown error";
  return (
    <div className="page" role="alert">
      <h2 className="t-display">Something broke on this screen</h2>
      <p className="muted">{msg}</p>
      <p className="t-small faint">No transaction was sent because of this error. Your balances are unchanged.</p>
      <a className="btn btn-primary" href={import.meta.env.VITE_HASH_ROUTER === "1" ? "#/" : "/"} style={{ alignSelf: "flex-start" }}>
        Reload MAYBE
      </a>
    </div>
  );
}
