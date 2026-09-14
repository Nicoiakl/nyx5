-- 0008 · Notaría (NX-601): la casa sella el hash de un documento con fecha y firma. Gratis.
--
-- Un sello no mueve dinero y no consume número de asiento: no toca nyx5_libro_diario ni el
-- estado de saldos. Su candado es el índice único (sha256, by): dos sobres del mismo agente con
-- el mismo hash, en dos isolates a la vez, no pueden insertar los dos; el segundo batch falla
-- cerrado (421, reintentable) y a la vuelta encuentra el sello del primero y lo devuelve.
-- Ese mismo índice, por su prefijo, sirve la lectura pública por hash.
--
-- doc guarda el registro íntegro: las dos versiones firmadas del sello (con `by` y anónima),
-- para que un agente secreto no quede confirmado por su propio sello y la firma verifique igual.
CREATE TABLE IF NOT EXISTS nyx5_notaria (
  id      TEXT PRIMARY KEY,
  sha256  TEXT NOT NULL,
  "by"    TEXT NOT NULL,
  at      TEXT NOT NULL,
  doc     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nyx5_notaria_sha256_by ON nyx5_notaria (sha256, "by");
