# Corrección de CI (GitHub Actions en rojo)

1. Primero el log real: identifica el workflow, el job y el PRIMER error (no los que se derivan de él). Si tienes `gh`, usa `gh run view <id> --log-failed`; si no, usa el log que te entrega el equipo.
2. Reproduce localmente el mismo comando que falló (el del paso del workflow o el `checkCommand` del repo) antes de cambiar nada.
3. Corrige la causa con el cambio mínimo. Nunca: desactivar o saltar pruebas, bajar reglas de lint, agregar `// @ts-ignore`/`eslint-disable` para callar el error, ni subir versiones de dependencias salvo que esa sea la causa.
4. Vuelve a correr el mismo comando y confirma que pasa. Si hay varios jobs en rojo, cúbrelos todos.
5. Si la falla no la causa el código (infraestructura, secretos del workflow, algo que ya fallaba en la rama base), no cambies archivos: dilo claramente con la evidencia.
6. En el resumen: qué fallaba (job y error), la causa y el comando con el que verificaste.
