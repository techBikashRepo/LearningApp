$enc = [System.Text.Encoding]::UTF8

$subjects = @("06-scalability-performance", "09-aws-cloud-deployment", "10-aws-core", "11-containers-deployment", "12-production-engineering", "13-architecture-career-readiness")

foreach ($s in $subjects) {
    Write-Output "=== $s ==="
    $files = Get-ChildItem "C:\Bikash\Workspace\LearningApp\content\$s\*\02-*.md"
    foreach ($f in $files) {
        $content = [System.IO.File]::ReadAllText($f.FullName, $enc)
        $m = [regex]::Match($content, '(?s)## SECTION 8[^\n]+\n\n?(.{0,150})')
        if ($m.Success) {
            $preview = $m.Groups[1].Value.Trim() -replace '\n', ' '
            Write-Output "  $($f.Name.Substring(0,30)): $($preview.Substring(0, [Math]::Min(120,$preview.Length)))"
        } else {
            Write-Output "  $($f.Name): NO SECTION 8 FOUND"
        }
    }
}
