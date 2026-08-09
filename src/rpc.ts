(async () => {
    // arrpc is ESM-only while the Electron utility entry point is compiled as CommonJS.
    const { default: RPCServer } = await (new Function("return import('arrpc')")());
    const port = process.parentPort;
    if (!port) throw new Error('arRPC utility process has no parent port');

    const detectables: unknown[] = process.env.detectables ? JSON.parse(process.env.detectables) : [];
    const rpc = await new RPCServer(detectables);

    rpc.on("activity", (data: string) => {
        const response = { type: "activity", data: data };
        port.postMessage(JSON.stringify(response));
    });

    rpc.on("invite", (code: string) => {
        const response = { type: "invite", code: code };
        port.postMessage(JSON.stringify(response));
    });

    port.on("message", async (e) => {
        if (e.data.message === "refreshProcessList") {
            const processes = await rpc.getProcessesList();
            const response = { type: "processList", data: processes };
            port.postMessage(JSON.stringify(response));
        }
    });
})().catch(error => {
    console.error('[arRPC] Fatal utility-process error:', error);
    process.exitCode = 1;
});
