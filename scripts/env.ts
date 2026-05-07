export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}
