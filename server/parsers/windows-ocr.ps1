param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation.UniversalApiContract,ContentType=WindowsRuntime]
$method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1} | Select-Object -First 1
function Await($op,[type]$type) {
  $task=$method.MakeGenericMethod(@($type)).Invoke($null,@($op))
  $task.GetAwaiter().GetResult()
}
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (!$engine) { throw 'Windows OCR language is unavailable' }
$files=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$results=@()
foreach ($entry in $files) {
  try {
    $file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($entry.path)) ([Windows.Storage.StorageFile])
    $stream=Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    try {
      $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      try { $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]); $results+=@{name=$entry.name;text=$result.Text;error=''} }
      finally { $bitmap.Dispose() }
    } finally { $stream.Dispose() }
  } catch { $results+=@{name=$entry.name;text='';error=$_.Exception.Message} }
}
ConvertTo-Json -InputObject @($results) -Depth 3 -Compress
