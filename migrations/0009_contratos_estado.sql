-- Índice por estado del contrato (NX-905). El reloj de la casa (verifica@ y el escrow que vence)
-- leía la tabla entera en cada tick; con esto lee sólo held/delivered. Índice de expresión sobre
-- el doc: el estado ya vive ahí y una columna aparte sería una segunda verdad que mantener.
CREATE INDEX IF NOT EXISTS nyx5_libro_contratos_estado ON nyx5_libro_contratos (json_extract(doc, '$.state'));
