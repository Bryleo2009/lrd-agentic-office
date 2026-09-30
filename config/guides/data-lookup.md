# Consulta de datos puntual

1. Ve directo a la consulta que responde la pregunta: nada de verificar permisos, explorar el esquema completo ni revisar código antes. Usa las lecciones del equipo para saber en qué tabla/campo buscar.
2. Órdenes: SIEMPRE busca con `LIKE`, nunca por igualdad. El número completo lleva un prefijo que varía (p. ej. `ORD-RDMI-260930123604`) y el usuario puede dar el número entero o solo los últimos dígitos: usa `LIKE '%<lo que dio>%'` sobre el número de orden y el correlativo en `cabecera_ordens`, con `LIMIT 5`.
   - De preferencia, filtra por la fecha de HOY (hora de Lima) primero; si no aparece, amplía a los últimos 7 días y luego sin filtro de fecha. Si los primeros 6 dígitos del número parecen una fecha (AAMMDD, p. ej. 260930 → 2026-09-30), prueba primero ese día.
   - Herramientas que buscan por número exacto (como `lrd_order_get`) úsalas solo DESPUÉS, con el número completo que devolvió el `LIKE`.
3. Máximo 3 consultas. Si hay varias coincidencias, lista hasta 5 (fecha, canal, estado) y detalla la más reciente.
4. Solo lectura, sin datos personales (documentos, teléfonos, correos, tarjetas): resume.
5. Responde en pocas líneas, como a alguien del equipo, e indica la consulta usada para cada cifra.
6. Un 404 o "no encontrado" NO significa que la herramienta esté rota ni que el dato no exista: prueba la búsqueda parcial (número y correlativo) y el otro entorno (Producción ↔ QA) antes de concluir. Di siempre en qué entorno estaba.
7. Si aun así no encuentras nada, di exactamente qué buscaste, con qué herramienta y en qué entornos, y qué dato ayudaría a encontrarlo.
