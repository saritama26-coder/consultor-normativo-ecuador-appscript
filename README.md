# Consultor Normativo Ecuador — sincronización con Apps Script

Este repositorio está preparado para sincronizar los archivos del proyecto con Google Apps Script mediante GitHub Actions y `clasp`.

## Archivos
- `Codigo.gs`: backend del Consultor Normativo.
- `Index.html`: interfaz web.
- `Clasificador.gs`: clasificador independiente de documentos; permanece en modo de prueba (`MODO_PRUEBA: true`).
- `appsscript.json`: manifiesto con runtime V8 y servicio avanzado Drive API v3.
- `.github/workflows/sync-apps-script.yml`: sincroniza al hacer push a `main` o al ejecutar manualmente el workflow.

## Antes de activar la sincronización
1. Crea un repositorio GitHub nuevo llamado `consultor-normativo-ecuador-appscript` bajo la cuenta `saritama26-coder`.
2. Sube el contenido de este paquete a la raíz del repositorio, incluida la carpeta `.github/workflows/`.
3. En el editor del proyecto de Apps Script vinculado a la URL web app proporcionada, copia el **ID del script** desde la URL del editor (`https://script.google.com/home/projects/ID_DEL_SCRIPT/edit`). No uses el ID de despliegue que aparece en la URL `/exec`.
4. En el repositorio, abre **Settings → Secrets and variables → Actions → New repository secret** y crea:
   - `CLASP_JSON`: contenido JSON con el campo `scriptId` y el ID del script correcto, por ejemplo `{"scriptId":"PEGAR_ID_REAL_DEL_SCRIPT","rootDir":"."}`.
   - `CLASPRC_JSON`: contenido completo del archivo `.clasprc.json` generado por `clasp login` en una sesión autorizada.
5. Ejecuta **Actions → Sincronizar Google Apps Script → Run workflow**. Revisa que termine en verde.
6. Para futuras modificaciones, edita los archivos del repositorio y haz `commit`/`push` a `main`. El workflow subirá los archivos al proyecto de Apps Script.

## Importante: el despliegue web no se actualiza automáticamente
`clasp push` sincroniza los archivos del editor, pero no publica una nueva versión de la implementación `/exec`. Después de sincronizar cambios, entra a Apps Script → **Implementar → Gestionar implementaciones → Editar** (icono de lápiz) → **Versión nueva** → **Implementar**. La URL puede mantenerse igual si editas la implementación existente.

## Seguridad y preservación de datos
- No publiques `.clasp.json`, `.clasprc.json`, tokens ni credenciales en el repositorio. El archivo `.clasp.json` se crea dentro de GitHub Actions desde el secreto `CLASP_JSON`.
- No ejecutes `configurarSistema()` ni `reindexarTodo()` durante la sincronización: el propio backend advierte que limpian las hojas del índice.
- No ejecutes el clasificador en modo real sin revisar el registro de prueba y confirmar las carpetas destino. Se mantiene `MODO_PRUEBA: true`.
- El workflow sincroniza el código; no copia ni migra las hojas de cálculo, los documentos de Drive ni los datos existentes.
- El manifiesto declara Drive API v3. Comprueba en Apps Script que el servicio avanzado Drive API esté habilitado y que el manifiesto coincida con el proyecto de destino.

## Límite de esta entrega
El paquete prepara los archivos y el flujo de sincronización. No crea el repositorio en GitHub ni puede vincularse al proyecto real hasta que se configuren el ID real del script y los secretos. La URL `/exec` por sí sola no revela de forma suficiente el ID editable que `clasp` necesita.
