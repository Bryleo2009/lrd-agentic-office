# Personajes

Cada carpeta contiene la apariencia de un agente.

## Rig 2.5D (por defecto)
`character.json` define colores, peinado, vestimenta y accesorio. `AgentRenderer` construye un rig articulado
(piernas con rodilla, brazos con codo, torso, cabeza, cabello, accesorio) en 4 direcciones isométricas.

Peinados: `side_part, curly, ponytail, bun, bob, buzz, wavy, long`.
Vestimenta: `blazer, hoodie, sweater, shirt, polo, blouse`.
Accesorios: `none, glasses, headphones, headset, badge, earrings`.

## Spritesheet (arte reemplazable)
Para usar arte propio, pon en la carpeta del agente un `spritesheet.json` (formato TexturePacker / PixiJS)
+ su `.png`, y cambia `"renderer": "spritesheet"` en `character.json`.
Animaciones esperadas (4 direcciones: `se, sw, ne, nw`):

`idle_*, walk_*, sit_*, type_*, read_*, think_*, talk_*, test_*, celebrate_*, blocked_*`

Ejemplo: `walk_se` con 8 frames. El pie del personaje debe estar en el anchor (0.5, 1).
