// WebUSB DFU + STM32 DfuSe implementation
// Based on webdfu (https://github.com/devanlai/webdfu), MIT License
// Adapted for Vial Web / Keychron STM32F4xx DFU flashing

"use strict";

var dfu = {};
var dfuse = {};

// ── DFU request codes ──────────────────────────────────────────────────────
dfu.DETACH    = 0;
dfu.DNLOAD    = 1;
dfu.UPLOAD    = 2;
dfu.GETSTATUS = 3;
dfu.CLRSTATUS = 4;
dfu.GETSTATE  = 5;
dfu.ABORT     = 6;

// ── DFU states ─────────────────────────────────────────────────────────────
dfu.appIDLE              = 0;
dfu.appDETACH            = 1;
dfu.dfuIDLE              = 2;
dfu.dfuDNLOAD_SYNC       = 3;
dfu.dfuDNBUSY            = 4;
dfu.dfuDNLOAD_IDLE       = 5;
dfu.dfuMANIFEST_SYNC     = 6;
dfu.dfuMANIFEST          = 7;
dfu.dfuMANIFEST_WAIT_RESET = 8;
dfu.dfuUPLOAD_IDLE       = 9;
dfu.dfuERROR             = 10;
dfu.STATUS_OK            = 0;

// ── Interface discovery ────────────────────────────────────────────────────
dfu.findDeviceDfuInterfaces = function(device) {
    let interfaces = [];
    for (let conf of device.configurations) {
        for (let iface of conf.interfaces) {
            for (let alt of iface.alternates) {
                // DFU class=0xFE, subclass=0x01, protocol=1(DFU) or 2(DfuSe)
                if (alt.interfaceClass    === 0xFE &&
                    alt.interfaceSubclass === 0x01 &&
                    (alt.interfaceProtocol === 1 || alt.interfaceProtocol === 2)) {
                    interfaces.push({
                        configuration: conf,
                        interface:     iface,
                        alternate:     alt,
                        name:          alt.interfaceName || null,
                    });
                }
            }
        }
    }
    return interfaces;
};

dfu.findAllDfuInterfaces = function() {
    return navigator.usb.getDevices().then(devices => {
        let result = [];
        for (let d of devices) {
            for (let iface of dfu.findDeviceDfuInterfaces(d))
                result.push(new dfu.Device(d, iface));
        }
        return result;
    });
};

// ── Parse USB configuration descriptor (raw bytes) ────────────────────────
dfu.parseConfigurationDescriptor = function(data) {
    let view     = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let desc     = { bConfigurationValue: view.getUint8(5), descriptors: [] };
    let offset   = view.getUint8(0); // skip the config descriptor itself
    while (offset < data.byteLength) {
        let len  = view.getUint8(offset);
        let type = view.getUint8(offset + 1);
        if (len === 0) break;
        let chunk = { bDescriptorType: type };
        if (type === 0x21 && len >= 9) { // DFU Functional Descriptor
            chunk.bmAttributes  = view.getUint8(offset + 2);
            chunk.wDetachTimeOut= view.getUint16(offset + 3, true);
            chunk.wTransferSize = view.getUint16(offset + 5, true);
            chunk.bcdDFUVersion = view.getUint16(offset + 7, true);
        }
        desc.descriptors.push(chunk);
        offset += len;
    }
    return desc;
};

// ── dfu.Device ─────────────────────────────────────────────────────────────
dfu.Device = function(device, settings) {
    this.device_   = device;
    this.settings  = settings;
    this.intfNumber= settings.interface.interfaceNumber;
    this.logProgress = null; // (bytesSent, total) callback
    this.logMsg    = (msg) => console.log("[dfu] " + msg);
};

dfu.Device.prototype.open = async function() {
    await this.device_.open();
    const cfgVal = this.settings.configuration.configurationValue;
    if (!this.device_.configuration ||
        this.device_.configuration.configurationValue !== cfgVal) {
        await this.device_.selectConfiguration(cfgVal);
    }
    if (!this.device_.configuration.interfaces[this.intfNumber].claimed) {
        await this.device_.claimInterface(this.intfNumber);
    }
    const alt = this.settings.alternate.alternateSetting;
    const iface = this.device_.configuration.interfaces[this.intfNumber];
    if (!iface.alternate || iface.alternate.alternateSetting !== alt) {
        await this.device_.selectAlternateInterface(this.intfNumber, alt);
    }
};

dfu.Device.prototype.close = async function() {
    try { await this.device_.releaseInterface(this.intfNumber); } catch {}
    try { await this.device_.close(); } catch {}
};

dfu.Device.prototype.requestOut = function(request, data, value = 0) {
    return this.device_.controlTransferOut({
        requestType: "class",
        recipient:   "interface",
        request,
        value,
        index: this.intfNumber,
    }, data).then(r => {
        if (r.status === "ok") return r.bytesWritten;
        throw new Error("controlTransferOut failed: " + r.status);
    });
};

dfu.Device.prototype.requestIn = function(request, length, value = 0) {
    return this.device_.controlTransferIn({
        requestType: "class",
        recipient:   "interface",
        request,
        value,
        index: this.intfNumber,
    }, length).then(r => {
        if (r.status === "ok") return r.data;
        throw new Error("controlTransferIn failed: " + r.status);
    });
};

dfu.Device.prototype.download = function(data, blockNum) {
    return this.requestOut(dfu.DNLOAD, data, blockNum);
};
dfu.Device.prototype.upload = function(length, blockNum) {
    return this.requestIn(dfu.UPLOAD, length, blockNum);
};
dfu.Device.prototype.getStatus = function() {
    return this.requestIn(dfu.GETSTATUS, 6).then(data => ({
        status:      data.getUint8(0),
        pollTimeout: data.getUint32(1, true) & 0xFFFFFF,
        state:       data.getUint8(4),
    }));
};
dfu.Device.prototype.clearStatus = function() {
    return this.requestOut(dfu.CLRSTATUS);
};
dfu.Device.prototype.getState = function() {
    return this.requestIn(dfu.GETSTATE, 1).then(d => d.getUint8(0));
};
dfu.Device.prototype.abort = function() {
    return this.requestOut(dfu.ABORT);
};

dfu.Device.prototype.poll_until = async function(predicate, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 30000); // default 30 s
    let status;
    do {
        if (Date.now() > deadline)
            throw new Error("poll_until timed out after " + (timeoutMs || 30000) + " ms");
        for (let retry = 0; retry < 5; retry++) {
            try { status = await this.getStatus(); break; } catch(e) {}
        }
        if (!status) throw new Error("Device not responding");
        await new Promise(r => setTimeout(r, status.pollTimeout || 2));
    } while (!predicate(status.state) && status.state !== dfu.dfuERROR);
    return status;
};

dfu.Device.prototype.poll_until_idle = function(targetState) {
    return this.poll_until(s => s === targetState);
};

dfu.Device.prototype.readConfigurationDescriptor = function(configIdx) {
    // GET_DESCRIPTOR for configuration descriptor
    return this.device_.controlTransferIn({
        requestType: "standard",
        recipient:   "device",
        request:     6,             // GET_DESCRIPTOR
        value:       0x0200 | configIdx,
        index:       0,
    }, 4).then(result => {
        // First read returns 4 bytes with total length at offset 2
        if (result.status !== "ok") throw new Error("GET_DESCRIPTOR failed");
        const totalLength = result.data.getUint16(2, true);
        return this.device_.controlTransferIn({
            requestType: "standard",
            recipient:   "device",
            request:     6,
            value:       0x0200 | configIdx,
            index:       0,
        }, totalLength);
    }).then(result => {
        if (result.status !== "ok") throw new Error("GET_DESCRIPTOR (full) failed");
        return new Uint8Array(result.data.buffer);
    });
};

dfu.Device.prototype.readInterfaceNames = async function() {
    // Returns a nested dict: names[config][iface][alt] = string
    const STD_USB_STRING_DESCRIPTOR = 3;
    let configs = {};
    for (let conf of this.device_.configurations) {
        let ifaceNames = {};
        for (let iface of conf.interfaces) {
            let altNames = {};
            for (let alt of iface.alternates) {
                if (alt.interfaceName != null) {
                    altNames[alt.alternateSetting] = alt.interfaceName;
                }
            }
            ifaceNames[iface.interfaceNumber] = altNames;
        }
        configs[conf.configurationValue] = ifaceNames;
    }
    return configs;
};

// Standard (non-DfuSe) download
dfu.Device.prototype.do_download = async function(transferSize, firmwareBuffer, manifestationTolerant) {
    let bytesSent = 0;
    const total   = firmwareBuffer.byteLength;
    let blockNum  = 0;

    while (bytesSent < total) {
        const chunkSize = Math.min(total - bytesSent, transferSize);
        const chunk     = firmwareBuffer.slice(bytesSent, bytesSent + chunkSize);
        const written   = await this.download(chunk, blockNum++);
        const status    = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
        if (status.status !== dfu.STATUS_OK)
            throw new Error(`DFU DOWNLOAD failed: state=${status.state} status=${status.status}`);
        bytesSent += written;
        if (this.logProgress) this.logProgress(bytesSent, total);
    }

    // End-of-download: empty block
    await this.download(new ArrayBuffer(0), blockNum++);

    if (manifestationTolerant) {
        await this.poll_until(s => s === dfu.dfuIDLE || s === dfu.dfuMANIFEST_WAIT_RESET);
    } else {
        try { await this.getStatus(); } catch {}
    }
    try { await this.device_.reset(); } catch {}
};

// ── STM32 DfuSe memory descriptor parsing ─────────────────────────────────
dfuse.parseMemoryDescriptor = function(desc) {
    // Format: "@<name> /0x<addr>/<count>*<size><unit>[flags],..."
    const nameEnd = desc.indexOf("/");
    const name    = desc.substring(1, nameEnd).trim();
    const segStr  = desc.substring(nameEnd + 1);
    let segments  = [];

    let match;
    const re = /0x([0-9a-fA-F]+)\/(\d+)\*(\d+)([KMGB]?)([abcdefg]+)/g;
    // Also handle the format: /0xADDR/N*SIZEu (u=1,Ka=1024,...)
    // Actually the format is: "0x08000000/01*016Ka,03*016Kg,..."
    // Let's do a simpler parse:
    const parts = segStr.split(",");
    let addr = null;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        // First part may contain the base address: "0x08000000/01*016Ka"
        let addrMatch = part.match(/^(0x[0-9a-fA-F]+)\/(.*)/);
        let segPart = part;
        if (addrMatch) {
            addr = parseInt(addrMatch[1], 16);
            segPart = addrMatch[2];
        }
        // segPart: "01*016Ka" or "03*016Kg"
        let segMatch = segPart.match(/^(\d+)\*(\d+)([KMGB]?)([a-g]+)/i);
        if (!segMatch || addr === null) continue;

        const count      = parseInt(segMatch[1]);
        let   sectorSize = parseInt(segMatch[2]);
        const unit       = segMatch[3].toUpperCase();
        const flags      = segMatch[4].toLowerCase();

        if      (unit === "K") sectorSize *= 1024;
        else if (unit === "M") sectorSize *= 1024 * 1024;

        // flags: a=read-only, g=read/erase/write, e=read/erase, etc.
        // bit0=readable, bit1=erasable, bit2=writable (simplified)
        const readable  = flags.includes("a") || flags.includes("g") || flags.includes("e");
        const erasable  = flags.includes("g") || flags.includes("e");
        const writable  = flags.includes("g");

        for (let s = 0; s < count; s++) {
            segments.push({
                start:      addr,
                end:        addr + sectorSize,
                sectorSize,
                readable,
                erasable,
                writable,
            });
            addr += sectorSize;
        }
    }
    return { name, segments };
};

// ── STM32F4 fallback sector layout (used when altName is empty) ───────────
// Internal Flash: 4×16K, 1×64K, 7×128K — total 1 MB starting at 0x08000000
dfuse.STM32F4_SECTORS = (function() {
    let segs = [];
    let addr = 0x08000000;
    const layout = [
        { count: 4,  size: 16   * 1024 },
        { count: 1,  size: 64   * 1024 },
        { count: 7,  size: 128  * 1024 },
    ];
    for (let g of layout) {
        for (let i = 0; i < g.count; i++) {
            segs.push({ start: addr, end: addr + g.size, sectorSize: g.size,
                        readable: true, erasable: true, writable: true });
            addr += g.size;
        }
    }
    return segs;
})();

// ── dfuse.Device ───────────────────────────────────────────────────────────
dfuse.Device = function(device, settings) {
    dfu.Device.call(this, device, settings);
    this.startAddress = NaN;

    // Parse memory layout from the interface alternate name
    // e.g. "@Internal Flash /0x08000000/01*016Ka,03*016Kg,01*064Kg,07*128Kg"
    const altName = settings.alternate.interfaceName || settings.alternate.name || "";
    console.log("[vial][dfu] DfuSe altName:", JSON.stringify(altName));
    if (altName.startsWith("@")) {
        this.memoryInfo = dfuse.parseMemoryDescriptor(altName);
        console.log("[vial][dfu] DfuSe memoryInfo segments:",
            this.memoryInfo.segments.map(s =>
                "0x" + s.start.toString(16) + "-0x" + s.end.toString(16) +
                " sz=" + s.sectorSize + " r=" + s.readable +
                " e=" + s.erasable + " w=" + s.writable
            )
        );
    } else {
        // No DfuSe memory descriptor from the device — use STM32F4 hardcoded layout
        // (4×16K + 1×64K + 7×128K at 0x08000000) so sector-by-sector erase works.
        this.memoryInfo = { name: "Internal Flash (fallback)", segments: dfuse.STM32F4_SECTORS };
        console.warn("[vial][dfu] DfuSe: no memory descriptor in altName — using hardcoded STM32F4 layout");
    }
};
dfuse.Device.prototype = Object.create(dfu.Device.prototype);
dfuse.Device.prototype.constructor = dfuse.Device;

// DfuSe special commands (sent as DNLOAD block 0)
dfuse.GET_COMMANDS  = 0x00;
dfuse.SET_ADDRESS   = 0x21;
dfuse.ERASE_SECTOR  = 0x41;

dfuse.Device.prototype.dfuseCommand = async function(command, param, paramLen) {
    let buf  = new ArrayBuffer(1 + (paramLen || 0));
    let view = new DataView(buf);
    view.setUint8(0, command);
    if (paramLen === 1) view.setUint8(1, param);
    else if (paramLen === 4) view.setUint32(1, param, true);
    await this.download(buf, 0); // block 0 = special command
    // Sector erase on STM32F4 can take up to ~2.5s per 128K sector;
    // allow 10s per command to handle worst-case slow flash.
    const status = await this.poll_until(s => s !== dfu.dfuDNBUSY, 10000);
    if (status.status !== dfu.STATUS_OK)
        throw new Error(`DfuSe command 0x${command.toString(16)} failed: status=${status.status}`);
};

dfuse.Device.prototype.getWritableSegments = function() {
    if (!this.memoryInfo) return [];
    return this.memoryInfo.segments.filter(s => s.writable);
};

dfuse.Device.prototype.getSectorStart = function(addr) {
    if (!this.memoryInfo) return addr;
    for (let seg of this.memoryInfo.segments) {
        if (addr >= seg.start && addr < seg.end) return seg.start;
    }
    return addr;
};

dfuse.Device.prototype.getSectorEnd = function(addr) {
    if (!this.memoryInfo) return addr; // sentinel: no info
    for (let seg of this.memoryInfo.segments) {
        if (addr >= seg.start && addr < seg.end) return seg.end;
    }
    return addr; // sentinel: addr not in any known segment
};

dfuse.Device.prototype.erase = async function(startAddr, length) {
    let addr = startAddr;
    let end  = startAddr + length;

    if (!this.memoryInfo || this.memoryInfo.segments.length === 0) {
        throw new Error("Erase: no memory info available (this should not happen)");
    }

    while (addr < end) {
        const nextEnd = this.getSectorEnd(addr);
        if (nextEnd <= addr) {
            // getSectorEnd returned something ≤ addr — segment info is broken,
            // bail out rather than spinning forever.
            throw new Error("Erase: getSectorEnd(0x" + addr.toString(16) + ") = 0x" +
                nextEnd.toString(16) + " (not advancing); memory descriptor may be wrong");
        }
        this.logMsg("Erasing sector at 0x" + addr.toString(16) +
            " (size " + (nextEnd - addr) + " bytes)...");
        await this.dfuseCommand(dfuse.ERASE_SECTOR, addr, 4);
        addr = nextEnd;
        if (this.logProgress) this.logProgress(addr - startAddr, end - startAddr);
    }
};

dfuse.Device.prototype.do_download = async function(transferSize, firmwareBuffer, manifestTolerant) {
    const total = firmwareBuffer.byteLength;

    // Determine start address
    let addr = isNaN(this.startAddress)
        ? (this.memoryInfo ? this.memoryInfo.segments[0].start : 0x08000000)
        : this.startAddress;

    this.logMsg(`DfuSe: flashing ${total} bytes to 0x${addr.toString(16).toUpperCase()}`);

    // Phase 1: Erase
    this.logMsg("Erasing...");
    await this.erase(addr, total);

    // Phase 2: Write
    this.logMsg("Writing...");
    let bytesSent = 0;
    let writeAddr = addr;

    while (bytesSent < total) {
        const chunkSize = Math.min(total - bytesSent, transferSize);
        const chunk     = firmwareBuffer.slice(bytesSent, bytesSent + chunkSize);

        // SET_ADDRESS then DNLOAD (block index 2 for data in DfuSe)
        await this.dfuseCommand(dfuse.SET_ADDRESS, writeAddr, 4);
        const written = await this.download(chunk, 2);
        const status  = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
        if (status.status !== dfu.STATUS_OK)
            throw new Error(`DfuSe write failed at 0x${writeAddr.toString(16)}: status=${status.status}`);

        writeAddr += chunkSize;
        bytesSent += written;
        if (this.logProgress) this.logProgress(bytesSent, total);
    }

    // Phase 3: Manifest — jump to start address
    this.logMsg("Manifesting...");
    await this.dfuseCommand(dfuse.SET_ADDRESS, addr, 4);
    await this.download(new ArrayBuffer(0), 0);
    try { await this.poll_until(s => s === dfu.dfuMANIFEST); } catch {}
    try { await this.device_.reset(); } catch {}
};
