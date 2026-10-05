const { execFile } = require("child_process");
const { names, renderLayout } = require("./tools");

module.exports = function toolTabs(session) {
  let queue = Promise.resolve();
  const action = (...args) => new Promise((resolve, reject) => {
    execFile("zellij", ["--session", session, "action", ...args],
      { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
  });
  const list = async () => JSON.parse(await action("list-tabs", "-s", "-j"));
  function serialized(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function create(name) {
    await action("new-tab", "--name", name, "--layout-string", renderLayout([name]));
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await list()).some((tab) => tab.name === name)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Could not restore ${name}`);
  }
  return {
    list,
    restore: () => serialized(async () => {
      const tabs = await list();
      if (!tabs.length) throw new Error("Nexus session is not ready");
      const active = tabs.find((tab) => tab.active)?.name || tabs[0].name;
      for (const name of names) {
        if (!tabs.some((tab) => tab.name === name)) await create(name);
      }
      await action("go-to-tab-name", active);
      return active;
    }),
    select: (name) => serialized(async () => {
      if (!names.includes(name)) throw new Error("Unknown Nexus tool");
      if (!(await list()).some((tab) => tab.name === name)) await create(name);
      await action("go-to-tab-name", name);
      return name;
    }),
  };
};
