// Shrinks a 1024×1024 icon to Apple's macOS icon grid: the artwork sits in the
// middle 824×824, leaving a transparent 100px margin (as other Mac apps do).
// Usage: swift scripts/pad-mac-icon.swift input.png output.png

import AppKit

let args = CommandLine.arguments
guard args.count == 3, let image = NSImage(contentsOfFile: args[1]) else {
    print("Usage: swift pad-mac-icon.swift input.png output.png")
    exit(1)
}

let canvas = 1024, artwork = 824, margin = (canvas - artwork) / 2
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.imageInterpolation = .high
image.draw(in: NSRect(x: margin, y: margin, width: artwork, height: artwork))
NSGraphicsContext.restoreGraphicsState()

try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
