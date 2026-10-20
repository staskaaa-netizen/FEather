param(
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host "FEather static host: http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."

try {
  while ($true) {
    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 150
      continue
    }
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        continue
      }

      $requestParts = $requestLine -split " "
      if ($requestParts.Count -lt 2 -or $requestParts[0] -ne "GET") {
        $body = [Text.Encoding]::UTF8.GetBytes("Method not allowed")
        $header = "HTTP/1.1 405 Method Not Allowed`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
        $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($headerBytes, 0, $headerBytes.Length)
        $stream.Write($body, 0, $body.Length)
        continue
      }

      while ($null -ne ($discard = $reader.ReadLine()) -and $discard -ne "") {
        # Discard request headers; the static server does not use them.
      }

      $requestPath = ($requestParts[1] -split "\?")[0]
      $relativePath = [Uri]::UnescapeDataString($requestPath).TrimStart("/")
      if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = "index.html"
      }

      $fullPath = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
      $insideRoot = $fullPath.StartsWith(
        $root + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
      )

      if (-not $insideRoot -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        $body = [Text.Encoding]::UTF8.GetBytes("Not found")
        $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
        $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($headerBytes, 0, $headerBytes.Length)
        $stream.Write($body, 0, $body.Length)
        continue
      }

      $extension = [IO.Path]::GetExtension($fullPath).ToLowerInvariant()
      $contentTypes = @{
        ".html" = "text/html; charset=utf-8"
        ".js" = "text/javascript; charset=utf-8"
        ".css" = "text/css; charset=utf-8"
        ".json" = "application/json; charset=utf-8"
        ".md" = "text/markdown; charset=utf-8"
        ".txt" = "text/plain; charset=utf-8"
        ".png" = "image/png"
      }
      $contentType = if ($contentTypes.ContainsKey($extension)) {
        $contentTypes[$extension]
      } else {
        "application/octet-stream"
      }

      $bytes = [IO.File]::ReadAllBytes($fullPath)
      $header = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($bytes, 0, $bytes.Length)
    } catch {
      Write-Warning $_.Exception.Message
    } finally {
      $client.Dispose()
    }
  }
} finally {
  $listener.Stop()
}
