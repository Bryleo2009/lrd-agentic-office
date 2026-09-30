import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Sin esto, un error al dibujar cualquier panel desmonta TODA la app y solo queda
 * el fondo azul. Con un límite por sección, falla solo esa sección y se puede reintentar.
 */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode; fullscreen?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}] error de interfaz`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`ui-error${this.props.fullscreen ? " full" : ""}`} role="alert">
        <b>Algo falló al mostrar {this.props.name}.</b>
        <span>La oficina sigue funcionando; puedes reintentar o recargar la página.</span>
        <code>{error.message}</code>
        <div className="ui-error-actions">
          <button onClick={() => this.setState({ error: null })}>Reintentar</button>
          <button onClick={() => location.reload()}>Recargar</button>
        </div>
      </div>
    );
  }
}
