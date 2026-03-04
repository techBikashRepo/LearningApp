$files = Get-ChildItem "C:\Bikash\Workspace\LearningApp\content\06-scalability-performance\*\01-*.md" | Select-Object -First 3
foreach ($f in $files) {
    Write-Output "=== $($f.Name) ==="
    $content = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    $m = [regex]::Match($content, '(?s)## SECTION 1[^\n]+\n(.+?)(?=\n## SECTION 2)')
    if ($m.Success) {
        $text = $m.Groups[1].Value
        Write-Output $text.Substring(0, [Math]::Min(600, $text.Length))
    }
    Write-Output "---"
}

Write-Output ""
Write-Output "=== SECTION 8 SAMPLE (Subject 06 Part 2 file 1) ==="
$p2 = Get-ChildItem "C:\Bikash\Workspace\LearningApp\content\06-scalability-performance\*\02-*.md" | Select-Object -First 1
$content2 = [System.IO.File]::ReadAllText($p2.FullName, [System.Text.Encoding]::UTF8)
$m2 = [regex]::Match($content2, '(?s)## SECTION 8[^\n]+\n(.+?)$')
if ($m2.Success) {
    Write-Output $m2.Groups[1].Value.Substring(0, [Math]::Min(800, $m2.Groups[1].Value.Length))
}
