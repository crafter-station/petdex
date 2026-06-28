declare module "@napi-rs/keyring" {
  export class Entry {
    constructor(service: string, account: string);
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): void;
  }
}
