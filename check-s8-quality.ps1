$enc = [System.Text.Encoding]::UTF8

# Check what content is immediately after ## SECTION 8 in all Subject 06 Part 2 files
$files = Get-ChildItem "C:\Bikash\Workspace\LearningApp\content\06-scalability-performance\*\02-*.md"
foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName, $enc)
    $m = [regex]::Match($content, '(?s)## SECTION 8[^\n]+\n\n?(.*?)(?:\n\n|$)', [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($m.Success) {
        $preview = $m.Groups[1].Value.Substring(0, [Math]::Min(120, $m.Groups[1].Value.Length)).Trim()
        Write-Output "$($f.Name) -> $preview"
    }
}
