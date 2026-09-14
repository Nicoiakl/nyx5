// La versión que el servidor declara de sí mismo. Un literal y no una lectura de package.json
// porque este módulo también corre en el edge, donde no hay sistema de archivos. Que no se
// desincronice lo cuida test/documentacion.test.js: si package.json cambia y esto no, falla.
export const VERSION = '0.7.0';
