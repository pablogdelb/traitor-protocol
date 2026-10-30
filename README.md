# Traitor Protocol
Juego online de deducción para 4–10 jugadores (móvil u ordenador). Sin dependencias: solo Node 18+.

    npm start        # http://localhost:3000

Uno crea sala, comparte el código/enlace y los demás se unen. Para jugar con amigos fuera de tu red,
despliega la carpeta en cualquier hosting Node (Render, Railway, Fly, Glitch…): arranca con `node server.js`
y usa la variable PORT.

## Reglas y balance (valores en `CFG` de server.js)
- Roles: 4–5 jugadores → 1 traidor · 6–8 → 2 · 9–10 → 3; siempre 1 detective; el resto, agentes.
- Traidor: mata en su sala (enfriamiento 25 s, primer asesinato a los 20 s), apagón (15 s, enfr. 50 s), tareas falsas.
- Detective: escanea (75 % fiable, 35 s) y dispara (30 s). Si dispara a un inocente, muere.
- Agentes ganan: barra de tareas al 100 % o todos los traidores eliminados (disparo o votación).
- Traidores ganan: traidores vivos >= resto de vivos.
- Cuerpo → Reportar → reunión con chat y votación; emergencia 1 vez por jugador en la Cafetería.
- Los muertos son fantasmas: pueden moverse y hacer tareas.
- Puntos: tarea +10, asesinato +20, traidor abatido +30, voto acertado +15, victoria +40, vivo +10, traidor vivo +20.
