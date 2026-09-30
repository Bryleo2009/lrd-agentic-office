import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary name="la oficina" fullscreen>
    <App />
  </ErrorBoundary>,
);
