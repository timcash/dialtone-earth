# Install the dialtone-earth CLI binary without changing shell profiles or PATH.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    [string]$Version = $(if ($env:DIALTONE_EARTH_VERSION) { $env:DIALTONE_EARTH_VERSION } else { '' }),
    [string]$InstallDir = $(if ($env:DIALTONE_EARTH_INSTALL_DIR) { $env:DIALTONE_EARTH_INSTALL_DIR } else { Join-Path $HOME '.local\bin' })
)

function Install-DialtoneEarth {
    $ErrorActionPreference = 'Stop'
    $downloadDir = $null
    $stageDir = $null
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            throw 'Unsupported OS: use install.sh on Linux or macOS.'
        }
        if ([string]::IsNullOrWhiteSpace($InstallDir)) { throw 'Install directory is empty.' }
        $provider = $null
        $drive = $null
        $destinationDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir, [ref]$provider, [ref]$drive)
        if ($provider.Name -ne 'FileSystem') { throw 'InstallDir must use the FileSystem provider.' }

        $downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('dialtone-earth-install-' + [Guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($downloadDir)
        $builtBinary = Join-Path $downloadDir 'dialtone-earth.exe'

        Add-Type -AssemblyName System.Net.Http
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.AllowAutoRedirect = $false
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        if ($handler.PSObject.Properties['SslProtocols']) {
            $handler.SslProtocols = [Security.Authentication.SslProtocols]::Tls12
        }
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(300)

        $downloadFile = {
            param([string]$Url, [string]$OutFile, [Uri]$BaseUri)
            $uri = [Uri]$Url
            for ($redirects = 0; ; $redirects++) {
                $allowLoopback = ($BaseUri.Scheme -eq 'http' -and $BaseUri.Host -eq '127.0.0.1' -and $uri.Scheme -eq 'http' -and $uri.Host -eq '127.0.0.1')
                if ($uri.Scheme -ne 'https' -and -not $allowLoopback) {
                    throw 'Refusing insecure download URL or redirect.'
                }
                $response = $client.GetAsync($uri).GetAwaiter().GetResult()
                try {
                    if ([int]$response.StatusCode -in 301, 302, 303, 307, 308) {
                        if ($redirects -ge 5 -or -not $response.Headers.Location) { throw 'Invalid download redirect.' }
                        $uri = New-Object Uri($uri, $response.Headers.Location)
                        continue
                    }
                    $null = $response.EnsureSuccessStatusCode()
                    $stream = [IO.File]::Create($OutFile)
                    try { $null = $response.Content.CopyToAsync($stream).GetAwaiter().GetResult() } finally { $stream.Dispose() }
                    break
                } finally { $response.Dispose() }
            }
        }

        try {
            if ($Version) {
                if ($Version -cnotmatch '\Av[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?\z') {
                    throw 'Version must be a tag such as v0.1.0.'
                }
                $arch = $env:PROCESSOR_ARCHITEW6432
                if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
                switch ($arch) {
                    'AMD64' { $asset = 'dialtone-earth-windows-amd64.exe' }
                    'ARM64' { $asset = 'dialtone-earth-windows-arm64.exe' }
                    default { throw "Unsupported Windows architecture: $arch." }
                }
                $releaseBase = 'https://dialtone.earth/releases/dialtone-earth'
                if ($env:DIALTONE_EARTH_RELEASE_BASE_URL) { $releaseBase = $env:DIALTONE_EARTH_RELEASE_BASE_URL.TrimEnd('/') }
                $baseUri = [Uri]$releaseBase
                if (-not $baseUri.IsAbsoluteUri -or ($baseUri.Scheme -ne 'https' -and -not ($baseUri.Scheme -eq 'http' -and $baseUri.Host -eq '127.0.0.1'))) {
                    throw 'Release base must use HTTPS (or loopback HTTP for tests).'
                }
                $url = "$releaseBase/download/$Version/$asset"
                $checksumPath = Join-Path $downloadDir 'checksum'
                & $downloadFile $url $builtBinary $baseUri
                & $downloadFile "$url.sha256" $checksumPath $baseUri

                $record = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($checksumPath))
                $pattern = '\A([0-9a-fA-F]{64})  ' + [Regex]::Escape($asset) + '\r?\n\z'
                if ($record -cnotmatch $pattern) { throw 'Invalid checksum record.' }
                $expected = $Matches[1].ToLowerInvariant()
                $hasher = [Security.Cryptography.SHA256]::Create()
                $fs = [IO.File]::OpenRead($builtBinary)
                try { $actual = [BitConverter]::ToString($hasher.ComputeHash($fs)).Replace('-', '').ToLowerInvariant() }
                finally { $fs.Dispose(); $hasher.Dispose() }
                if ($actual -ne $expected) { throw 'SHA-256 mismatch; previous install preserved.' }
                $label = $Version
            } else {
                if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
                    throw 'Go 1.24+ is required for source installs (or pass -Version vX.Y.Z for a release binary).'
                }
                $sourceUrl = 'https://dialtone.earth/api/code/dialtone-earth/archive/main.zip'
                if ($env:DIALTONE_EARTH_SOURCE_URL) { $sourceUrl = $env:DIALTONE_EARTH_SOURCE_URL }
                $sourceUri = [Uri]$sourceUrl
                if (-not $sourceUri.IsAbsoluteUri -or ($sourceUri.Scheme -ne 'https' -and -not ($sourceUri.Scheme -eq 'http' -and $sourceUri.Host -eq '127.0.0.1'))) {
                    throw 'Source URL must use HTTPS (or loopback HTTP for tests).'
                }
                $archivePath = Join-Path $downloadDir 'source.zip'
                $extractDir = Join-Path $downloadDir 'src'
                & $downloadFile $sourceUrl $archivePath $sourceUri
                Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
                $goMod = Get-ChildItem -Path $extractDir -Filter 'go.mod' -Recurse -Depth 2 | Select-Object -First 1
                if (-not $goMod) { throw 'Source archive does not contain go.mod.' }
                Push-Location $goMod.DirectoryName
                try {
                    & go build -o $builtBinary .
                    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE." }
                } finally {
                    Pop-Location
                }
                $label = 'main (built from source)'
            }
        } finally {
            $client.Dispose()
            $handler.Dispose()
        }

        if ((Get-Item -LiteralPath $builtBinary).Length -eq 0) { throw 'Empty binary.' }

        $null = [IO.Directory]::CreateDirectory($destinationDir)
        $destination = Join-Path $destinationDir 'dialtone-earth.exe'
        $stageDir = Join-Path $destinationDir ('.dialtone-earth-install-' + [Guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($stageDir)
        $staged = Join-Path $stageDir 'dialtone-earth.exe'
        [IO.File]::Copy($builtBinary, $staged)
        if ([IO.File]::Exists($destination)) {
            $backup = Join-Path $stageDir 'dialtone-earth.previous.exe'
            [IO.File]::Replace($staged, $destination, $backup)
        } else {
            [IO.File]::Move($staged, $destination)
        }
        Write-Host "Installed dialtone-earth ($label) to $destination"
        Write-Host "Add $destinationDir to your PATH, or run `"$destination`" help"
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
        if ($downloadDir) { Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
        if ($stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Install-DialtoneEarth
