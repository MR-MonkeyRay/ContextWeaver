import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLanguageSpec } from '../src/chunking/LanguageSpec.js';
import { getParser, isLanguageSupported } from '../src/chunking/ParserPool.js';
import { getLanguage, isAllowedExtension } from '../src/scanner/language.js';
import { CSharpResolver } from '../src/search/resolvers/CSharpResolver.js';
import { DartResolver } from '../src/search/resolvers/DartResolver.js';
import { createResolvers } from '../src/search/resolvers/index.js';
import { KotlinResolver } from '../src/search/resolvers/KotlinResolver.js';
import { PhpResolver } from '../src/search/resolvers/PhpResolver.js';
import { RubyResolver } from '../src/search/resolvers/RubyResolver.js';
import { SwiftResolver } from '../src/search/resolvers/SwiftResolver.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('多语言支持', () => {
  it('识别新增语言与 C# 扩展名', () => {
    const cases = [
      ['src/Main.kt', 'kotlin'],
      ['build.gradle.kts', 'kotlin'],
      ['src/index.php', 'php'],
      ['app/user.rb', 'ruby'],
      ['Sources/App.swift', 'swift'],
      ['lib/main.dart', 'dart'],
      ['Program.cs', 'c_sharp'],
      ['script.csx', 'c_sharp'],
    ] as const;

    for (const [filePath, language] of cases) {
      expect(getLanguage(filePath)).toBe(language);
      expect(isAllowedExtension(filePath)).toBe(true);
    }
  });

  it('注册新增语言的 AST 支持和语义分片配置', () => {
    for (const language of ['kotlin', 'php', 'ruby', 'swift', 'dart', 'c_sharp']) {
      expect(isLanguageSupported(language)).toBe(true);
      const spec = getLanguageSpec(language);
      expect(spec).not.toBeNull();
      expect(spec?.hierarchy.size).toBeGreaterThan(0);
      expect(spec?.commentTypes.size).toBeGreaterThan(0);
    }
  });

  it('条件语法包不可用时静默降级且不会重复输出错误', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const language of ['kotlin', 'swift', 'dart']) {
      const parser = await getParser(language);
      const cachedParser = await getParser(language);
      // Kotlin/Swift/Dart 的 npm 包在部分 Node ABI 或缺少原生构建产物时不可加载；
      // scanner/processor.ts 会在 parser 为 null 时使用行分片兜底。
      expect(parser === null || typeof parser.parse === 'function').toBe(true);
      expect(cachedParser === parser || cachedParser === null).toBe(true);
    }

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('验证稳定语言 Tree-sitter 解析器加载能力', async () => {
    for (const language of ['php', 'ruby']) {
      const parser = await getParser(language);
      expect(parser, `${language} grammar should load in this environment`).not.toBeNull();
    }
  });

  it('注册新增导入解析器', () => {
    const resolvers = createResolvers();
    for (const filePath of [
      'src/Main.kt',
      'src/index.php',
      'app/user.rb',
      'Sources/App.swift',
      'lib/main.dart',
      'Program.csx',
    ]) {
      expect(resolvers.some((resolver) => resolver.supports(filePath))).toBe(true);
    }
  });
});

describe('新增语言解析器', () => {
  it('KotlinResolver 提取导入并按包路径解析', () => {
    const resolver = new KotlinResolver();
    const content = `
import com.example.UserService
import com.example.tools.*
import com.example.Payment as Pay
`;
    expect(resolver.extract(content)).toEqual([
      'com.example.UserService',
      'com.example.tools.*',
      'com.example.Payment',
    ]);

    const allFiles = new Set([
      'src/main/kotlin/com/example/UserService.kt',
      'src/main/kotlin/com/example/tools/Formatter.kt',
      'src/main/kotlin/com/example/Payment.kts',
    ]);

    expect(resolver.resolve('com.example.UserService', 'src/main/kotlin/App.kt', allFiles)).toBe(
      'src/main/kotlin/com/example/UserService.kt',
    );
    expect(resolver.resolve('com.example.tools.*', 'src/main/kotlin/App.kt', allFiles)).toBe(
      'src/main/kotlin/com/example/tools/Formatter.kt',
    );
    expect(resolver.resolve('com.example.Payment', 'src/main/kotlin/App.kt', allFiles)).toBe(
      'src/main/kotlin/com/example/Payment.kts',
    );
  });

  it('KotlinResolver 解析仓库根相对包路径', () => {
    const resolver = new KotlinResolver();
    const allFiles = new Set([
      'com/example/UserService.kt',
      'com/example/tools/Formatter.kt',
      'src/main/kotlin/com/example/UserService.kt',
    ]);

    expect(resolver.resolve('com.example.UserService', 'Main.kt', allFiles)).toBe(
      'com/example/UserService.kt',
    );
    expect(resolver.resolve('com.example.tools.*', 'Main.kt', allFiles)).toBe(
      'com/example/tools/Formatter.kt',
    );
  });

  it('PhpResolver 展开 use 分组、别名、function/const 并解析路径', () => {
    const resolver = new PhpResolver();
    const content = String.raw`
use App\Services\UserService;
use App\Repositories\UserRepository as Repo;
use App\Domain\{OrderService, PaymentService as Pay};
use function App\Utils\formatName;
use const App\Config\DEFAULT_LIMIT;
`;

    expect(resolver.extract(content)).toEqual([
      String.raw`App\Services\UserService`,
      String.raw`App\Repositories\UserRepository`,
      String.raw`App\Domain\OrderService`,
      String.raw`App\Domain\PaymentService`,
      String.raw`App\Utils\formatName`,
      String.raw`App\Config\DEFAULT_LIMIT`,
    ]);

    const allFiles = new Set([
      'src/App/Services/UserService.php',
      'src/App/Domain/PaymentService.php',
      'src/Other/App/Services/UserService.php',
    ]);

    expect(
      resolver.resolve(
        String.raw`App\Services\UserService`,
        'src/App/Controllers/AuthController.php',
        allFiles,
      ),
    ).toBe('src/App/Services/UserService.php');
    expect(
      resolver.resolve(
        String.raw`App\Domain\PaymentService`,
        'src/App/Controllers/AuthController.php',
        allFiles,
      ),
    ).toBe('src/App/Domain/PaymentService.php');
  });

  it('PhpResolver 解析仓库根相对命名空间路径', () => {
    const resolver = new PhpResolver();
    const allFiles = new Set(['App/Services/UserService.php', 'src/App/Services/UserService.php']);

    expect(
      resolver.resolve(
        String.raw`App\Services\UserService`,
        'App/Controllers/AuthController.php',
        allFiles,
      ),
    ).toBe('App/Services/UserService.php');
  });

  it('RubyResolver 解析 require、require_relative 与 autoload', () => {
    const resolver = new RubyResolver();
    const content = `
require 'rails/engine'
require_relative '../../lib/custom_loader'
autoload :UserService, 'services/user_service'
`;

    expect(resolver.extract(content)).toEqual([
      'require:rails/engine',
      'require_relative:../../lib/custom_loader',
      'autoload:services/user_service',
    ]);

    const allFiles = new Set([
      'app/models/user.rb',
      'lib/custom_loader.rb',
      'services/user_service.rb',
      'vendor/rails/engine.rb',
    ]);

    expect(
      resolver.resolve('require_relative:../../lib/custom_loader', 'app/models/user.rb', allFiles),
    ).toBe('lib/custom_loader.rb');
    expect(resolver.resolve('autoload:services/user_service', 'app/models/user.rb', allFiles)).toBe(
      'services/user_service.rb',
    );
    expect(resolver.resolve('require:rails/engine', 'app/models/user.rb', allFiles)).toBe(
      'vendor/rails/engine.rb',
    );
  });

  it('RubyResolver 解析仓库根相对 require 路径', () => {
    const resolver = new RubyResolver();
    const allFiles = new Set(['rails/engine.rb', 'vendor/rails/engine.rb']);

    expect(resolver.resolve('require:rails/engine', 'app/models/user.rb', allFiles)).toBe(
      'rails/engine.rb',
    );
  });

  it('SwiftResolver 提取 import 变体并解析精确与模块级路径', () => {
    const resolver = new SwiftResolver();
    const content = `
import Foundation
import struct ProjectCore.Logger
@testable import AppModule
`;

    expect(resolver.extract(content)).toEqual(['Foundation', 'ProjectCore.Logger', 'AppModule']);

    const allFiles = new Set([
      'Sources/Foundation.swift',
      'Sources/ProjectCore/Logger.swift',
      'Sources/AppModule/Feature.swift',
    ]);

    expect(
      resolver.resolve('ProjectCore.Logger', 'Sources/AppModule/Feature.swift', allFiles),
    ).toBe('Sources/ProjectCore/Logger.swift');
    expect(resolver.resolve('AppModule', 'Sources/AppModule/Feature.swift', allFiles)).toBe(
      'Sources/AppModule/Feature.swift',
    );
  });

  it('SwiftResolver 解析仓库根相对模块文件与模块目录', () => {
    const resolver = new SwiftResolver();
    const allFiles = new Set([
      'Foundation.swift',
      'ProjectCore/Logger.swift',
      'Sources/ProjectCore/Logger.swift',
    ]);

    expect(resolver.resolve('Foundation', 'App.swift', allFiles)).toBe('Foundation.swift');
    expect(resolver.resolve('ProjectCore.Logger', 'App.swift', allFiles)).toBe(
      'ProjectCore/Logger.swift',
    );
  });

  it('DartResolver 解析相对 import/export/part', () => {
    const resolver = new DartResolver();
    const content = `
import './models/user.dart';
export '../shared/helpers.dart';
part '../generated/user.g.dart';
part of './feature.dart';
`;

    expect(resolver.extract(content)).toEqual([
      './models/user.dart',
      '../shared/helpers.dart',
      '../generated/user.g.dart',
      './feature.dart',
    ]);

    const allFiles = new Set([
      'lib/features/models/user.dart',
      'lib/shared/helpers.dart',
      'lib/generated/user.g.dart',
      'lib/features/feature.dart',
      'lib/features/without_ext.dart',
    ]);

    expect(resolver.resolve('./models/user.dart', 'lib/features/entry.dart', allFiles)).toBe(
      'lib/features/models/user.dart',
    );
    expect(resolver.resolve('../shared/helpers.dart', 'lib/features/entry.dart', allFiles)).toBe(
      'lib/shared/helpers.dart',
    );
    expect(resolver.resolve('./without_ext', 'lib/features/entry.dart', allFiles)).toBe(
      'lib/features/without_ext.dart',
    );
  });
});

describe('CSharpResolver 增强', () => {
  it('提取 global/static/alias using 并规范化 global:: 与 @ 标识符', () => {
    const resolver = new CSharpResolver();
    const content = `
using System.Text;
using static System.Math;
global using global::System.Linq;
using IO = System.IO;
using @Alias = global::MyApp.@namespace.@class;
`;

    expect(resolver.extract(content)).toEqual([
      'System.Text',
      'System.Math',
      'System.Linq',
      'System.IO',
      'MyApp.namespace.class',
    ]);

    const allFiles = new Set([
      'System/Linq.cs',
      'src/System/Text.cs',
      'src/System/Math.cs',
      'src/System/IO.cs',
      'src/MyApp/namespace/class.cs',
      'scripts/MyApp/namespace/class.csx',
    ]);

    expect(resolver.resolve('global::System.Linq', 'src/App/Program.cs', allFiles)).toBe(
      'System/Linq.cs',
    );
    expect(
      resolver.resolve('global::MyApp.@namespace.@class', 'src/App/Program.cs', allFiles),
    ).toBe('src/MyApp/namespace/class.cs');
  });

  it('解析仓库根相对 C# 命名空间路径', () => {
    const resolver = new CSharpResolver();
    const allFiles = new Set(['System/Linq.cs', 'src/System/Linq.cs']);

    expect(resolver.resolve('global::System.Linq', 'Program.cs', allFiles)).toBe('System/Linq.cs');
  });
});
