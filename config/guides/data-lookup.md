# Consulta de datos puntual

1. Ve directo a la consulta que responde la pregunta: nada de verificar permisos, explorar el esquema completo ni revisar código antes. Usa las lecciones del equipo para saber en qué tabla/campo buscar.
2. En LRD el número de orden completo lleva prefijo de canal/sede (p. ej. `ORD-RDMI-260930123604`). Si el usuario da solo los dígitos ("la orden 260930123604", "termina en 201631"), un `lrd_order_get` con esos dígitos devuelve 404 aunque la orden exista: busca por coincidencia parcial en `cabecera_ordens` (número y correlativo a la vez, p. ej. `LIKE '%260930123604'`, `LIMIT 5`) y luego consulta el detalle con el número completo.
3. Máximo 3 consultas. Si hay varias coincidencias, lista hasta 5 (fecha, canal, estado) y detalla la más reciente.
4. Solo lectura, sin datos personales (documentos, teléfonos, correos, tarjetas): resume.
5. Responde en pocas líneas, como a alguien del equipo, e indica la consulta usada para cada cifra.
6. Un 404 o "no encontrado" NO significa que la herramienta esté rota ni que el dato no exista: prueba la búsqueda parcial (número y correlativo) y el otro entorno (Producción ↔ QA) antes de concluir. Di siempre en qué entorno estaba.
7. Si aun así no encuentras nada, di exactamente qué buscaste, con qué herramienta y en qué entornos, y qué dato ayudaría a encontrarlo.
