export interface StoredResponse {
  response: unknown
  input: unknown
  instructions: string | undefined
  model: string | undefined
  createdAt: number
}

export class ResponseStore {
  #responses = new Map<string, StoredResponse>()
  #activeRequests = new Map<string, AbortController>()

  store(id: string, entry: StoredResponse): void {
    this.#responses.set(id, entry)
  }

  get(id: string): StoredResponse | undefined {
    return this.#responses.get(id)
  }

  registerActive(id: string, controller: AbortController): void {
    this.#activeRequests.set(id, controller)
  }

  deregisterActive(id: string): void {
    this.#activeRequests.delete(id)
  }

  cancel(id: string): boolean {
    const controller = this.#activeRequests.get(id)
    if (!controller) return false
    controller.abort()
    return true
  }
}
