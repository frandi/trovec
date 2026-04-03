# **Contributing to Trovec**

First off, thank you for considering contributing to Trovec!

Trovec is built on the idea of being a lightweight, accessible vector database ecosystem, and community involvement is what makes open-source projects thrive.

We want to make it clear: **You do not need to write code to contribute.** Whether you are building an app with Trovec, reporting a bug, proposing a new feature, or writing a new embedder adapter, your help is incredibly valuable.

## **How You Can Contribute**

### **1. Use Trovec in Your Projects**

The absolute best way to contribute is simply to use Trovec! Build things with it, test its limits, and integrate it into your applications. Real-world usage is what uncovers edge cases, inspires new features, and validates the project. If you build something cool with Trovec, let us know—we'd love to see it!

### **2. Share Ideas and Feature Requests**

As you use Trovec, you might think of a new feature, a new embedder adapter, or a way to make the CLI better. We want to hear those ideas!

* Check the [Issues](https://github.com/frandi/trovec/issues) to see if someone has already suggested it.
* If not, open a new Issue. Provide a clear explanation of your idea, why it's useful for your use case, and how it might work.

### **3. Report Bugs**

If you find a bug while using the packages, please report it! Good bug reports make it much easier for us to fix issues quickly.

* Check existing issues to avoid duplicates.
* When logging a bug, please include:
  * Your Node.js version.
  * Which package(s) are causing the issue (e.g., @trovec/core, @trovec/embedder-openai).
  * A clear set of steps to reproduce the issue.
  * What you expected to happen vs. what actually happened.

### **4. Improve Documentation**

Documentation is the heart of a good developer experience. If you find a typo, an unclear explanation, or a missing example in any of our README.md files or JSDoc comments, please submit a Pull Request!

### **5. Contribute Code**

Whether it's fixing a bug or adding a core feature, code contributions are always welcome. If you're interested in building a new embedder adapter, see the [Building a New Adapter](#-building-a-new-adapter) section below—adapters live in their own repositories.

## **Local Development Setup**

Trovec is managed as an **npm workspaces monorepo**. This means all the packages (core, cli, adapters, etc.) are housed in this single repository.

### **Prerequisites**

* **Node.js** (v18+ recommended)
* **npm** (v7+ to support workspaces)

### **Getting Started**

1. **Fork the repository** to your own GitHub account.
2. **Clone your fork** locally:
```bash
git clone https://github.com/YOUR_USERNAME/trovec.git
cd trovec
```
3. **Install dependencies** (this will link all workspace packages together):
```bash
npm install
```
4. **Build all packages**:
```bash
npm run build --workspaces
```

### **Running Tests**

We use [Vitest](https://vitest.dev/) for testing across all packages.

* Run all tests across the monorepo:
```bash
npm test
```
* Run tests for a specific package:
```bash
npm test --workspace=packages/core
```

## **Building a New Adapter**

Because Trovec is an ecosystem, one of the best ways to contribute is by writing new embedder adapters (e.g., Anthropic, Cohere, HuggingFace).

New adapters do not need to live in the Trovec repository—this is intentional to keep the codebase lean. You can publish your adapter in your own repository or package. As long as it correctly implements the Embedder interface defined in @trovec/core, it will integrate seamlessly with the Trovec ecosystem.

If you are building an adapter:

1. Look at @trovec/embedder-openai or @trovec/embedder-local as reference implementations.
2. Ensure it implements the Embedder interface defined in @trovec/core.
3. Publish it in your own repository or npm package.

We are considering creating a hub to showcase community-contributed adapters in the future. In the meantime, feel free to [open an issue](https://github.com/frandi/trovec/issues) to share your adapter with the community!

## **Pull Request Process**

When you're ready to submit your changes, please follow these steps:

1. **Create a branch** for your feature or bugfix (e.g., `feature/my-awesome-feature` or `bugfix/issue-123`).
2. **Write tests** for your changes if applicable.
3. **Ensure the test suite passes** by running `npm test`.
4. **Commit your changes** with a clear, descriptive commit message.
5. **Push to your fork** and submit a Pull Request against the main branch of the frandi/trovec repository.

### **Code Review**

Once you open a PR, a maintainer will review your code. We might suggest some changes or ask for clarification. Don't worry—code review is a collaborative process, and we are here to help get your PR merged!

## **Questions?**

If you're stuck, unsure about an approach, or just want to chat about the project, feel free to [open a discussion](https://github.com/frandi/trovec/discussions) or reach out via [Issues](https://github.com/frandi/trovec/issues). We're happy to help!

## **Code of Conduct**

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). We are committed to providing a welcoming, inclusive, and harassment-free experience for everyone.
