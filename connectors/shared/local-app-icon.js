// Launch Services locates the bundle. AppKit draws its icon into an explicit
// pixel buffer so the result is independent of the current screen's scale.
ObjC.import("AppKit")
function installedIcon(ids, maxBytes, locate) {
  for (const id of ids) {
    try {
      const url = locate(id)
      if (!url || url.isNil()) continue
      const root = ObjC.unwrap(url.URLByResolvingSymlinksInPath.path)
      function resource(path) {
        const resolved = ObjC.unwrap($(root + "/" + path).stringByResolvingSymlinksInPath)
        if (!resolved.startsWith(root + "/")) throw Error("outside bundle")
        return resolved
      }
      const info = $.NSDictionary.dictionaryWithContentsOfFile(resource("Contents/Info.plist"))
      if (ObjC.unwrap(info.objectForKey("CFBundleIdentifier")) !== id) continue
      const name = ObjC.unwrap(info.objectForKey("CFBundleIconFile"))
      if (typeof name !== "string" || !name || name.includes("/") || name === "." || name === "..") continue
      const file = resource("Contents/Resources/" + (/\.icns$/i.test(name) ? name : name + ".icns"))
      const icon = $.NSImage.alloc.initWithContentsOfFile(file)
      if (!icon || icon.isNil() || !icon.valid) continue
      const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, 128, 128, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0)
      const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap)
      $.NSGraphicsContext.saveGraphicsState
      try {
        $.NSGraphicsContext.setCurrentContext(context)
        context.imageInterpolation = $.NSImageInterpolationHigh
        icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 128, 128), $.NSZeroRect, $.NSCompositingOperationCopy, 1)
      } finally {
        $.NSGraphicsContext.restoreGraphicsState
      }
      const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
      if (!png || png.isNil() || !png.length || png.length > maxBytes) continue
      return ObjC.unwrap(png.base64EncodedStringWithOptions(0))
    } catch (_) {}
  }
  return ""
}

function run([maxBytes, ...ids]) {
  return installedIcon(ids, Number(maxBytes), id => $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id))
}
