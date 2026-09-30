# Consulta de datos puntual

1. Ve directo a la consulta que responde la pregunta: nada de verificar permisos, explorar el esquema completo ni revisar código antes. Usa las lecciones del equipo para saber en qué tabla/campo buscar.
2. Para "termina en 201631" o números parciales, busca por coincidencia parcial en los campos de número/correlativo a la vez (p. ej. `LIKE '%201631'`) y limita (`LIMIT 5`).
3. Máximo 3 consultas. Si hay varias coincidencias, lista hasta 5 (fecha, canal, estado) y detalla la más reciente.
4. Solo lectura, sin datos personales (documentos, teléfonos, correos, tarjetas): resume.
5. Responde en pocas líneas, como a alguien del equipo, e indica la consulta usada para cada cifra.
6. Un 404 o "no encontrado" NO significa que la herramienta esté rota ni que el dato no exista: prueba la búsqueda parcial (número y correlativo) y el otro entorno (Producción ↔ QA) antes de concluir. Di siempre en qué entorno estaba.
7. Si aun así no encuentras nada, di exactamente qué buscaste, con qué herramienta y en qué entornos, y qué dato ayudaría a encontrarlo.
