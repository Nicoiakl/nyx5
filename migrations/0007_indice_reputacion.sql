-- 0007 · NX-302: el índice federado ordena por reputación y filtra por etiqueta, idioma y precio.
--
-- Columnas nuevas sobre nyx5_indice_agentes: tags y langs (JSON de la ficha), price_min (tokens,
-- el menor de profile.services[].price.tokens, NULL sin precio), score (reputación arbitrada por
-- verifica@ de la casa del agente, NULL sin historial), jobs_done (entregas arbitradas y liberadas),
-- y la generación de cada fila con un historial corto de sus puntajes (gen, first_gen, hist) para
-- que un recorrido por cursor no repita ni salte a quien cambió de puntaje entre página y página
-- (src/correo/indice.js explica el mecanismo).
--
-- Por qué DROP + CREATE y no ALTER TABLE ADD COLUMN: SQLite no tiene ADD COLUMN IF NOT EXISTS, así
-- que un ALTER aplicado dos veces falla. Esta tabla es una CACHÉ que el rastreo reconstruye entera
-- (indexReplaceAgents borra e inserta por casa), así que vaciarla no pierde nada que no vuelva en
-- el siguiente rastreo (crawlMinutes; en producción, 15 min o el siguiente alta de casa). Hasta
-- entonces /index/agents responde vacío: aplicar en una ventana en que eso sea aceptable.
DROP TABLE IF EXISTS nyx5_indice_agentes;
CREATE TABLE IF NOT EXISTS nyx5_indice_agentes (
  house      TEXT NOT NULL,
  address    TEXT NOT NULL,
  doc        TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  langs      TEXT NOT NULL DEFAULT '[]',
  price_min  INTEGER,
  score      REAL,
  jobs_done  INTEGER,
  gen        INTEGER NOT NULL DEFAULT 0,
  first_gen  INTEGER NOT NULL DEFAULT 0,
  hist       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (house, address)
);
-- El orden de la búsqueda: puntaje DESC, dirección ASC. Los nulos van al final (NULLS LAST en la consulta).
CREATE INDEX IF NOT EXISTS idx_nyx5_indice_agentes_score ON nyx5_indice_agentes (score DESC, address ASC);
