export const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
      body { display: grid; place-items: center; }
      img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    </style>
  </head>
  <body>
    <img id="preview-frame" alt="Live browser preview">
    <script>
      const frame = document.getElementById("preview-frame");
      window.previewPictureInPicture.onFrame((next) => {
        frame.src = "data:image/jpeg;base64," + next.data;
      });
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};
