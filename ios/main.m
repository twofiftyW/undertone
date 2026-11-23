#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#include <Python.h>

static BOOL addPath(PyConfig *config, NSString *path) {
    wchar_t *wide = Py_DecodeLocale(path.fileSystemRepresentation, NULL);
    if (wide == NULL) return NO;
    PyStatus status = PyWideStringList_Append(&config->module_search_paths, wide);
    PyMem_RawFree(wide);
    return !PyStatus_Exception(status);
}

static NSURL *startEngine(void) {
    NSBundle *bundle = NSBundle.mainBundle;
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *files = [[manager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"Undertone"];
    NSURL *cache = [[manager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"Undertone"];
    NSString *home = [bundle.bundlePath stringByAppendingPathComponent:@"python"];
    NSString *stdlib = [home stringByAppendingPathComponent:@"lib/python3.14"];
    NSString *source = [bundle.bundlePath stringByAppendingPathComponent:@"engine"];
    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    config.write_bytecode = 0;
    config.module_search_paths_set = 1;
    PyStatus status = PyConfig_SetBytesString(&config, &config.home, home.fileSystemRepresentation);
    if (PyStatus_Exception(status) || !addPath(&config, stdlib)
        || !addPath(&config, [stdlib stringByAppendingPathComponent:@"lib-dynload"]) || !addPath(&config, source)) {
        PyConfig_Clear(&config);
        return nil;
    }
    status = Py_InitializeFromConfig(&config);
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) {
        NSLog(@"Undertone Python initialization failed: %s", status.err_msg);
        return nil;
    }
    PyObject *module = PyImport_ImportModule("runtime");
    PyObject *start = module ? PyObject_GetAttrString(module, "start") : NULL;
    PyObject *reply = start ? PyObject_CallFunction(start, "ssss", files.fileSystemRepresentation, cache.fileSystemRepresentation,
        [bundle.bundlePath stringByAppendingPathComponent:@"web"].fileSystemRepresentation,
        [bundle.infoDictionary[@"UndertoneVersion"] UTF8String]) : NULL;
    const char *url = reply ? PyUnicode_AsUTF8(reply) : NULL;
    NSURL *result = url ? [NSURL URLWithString:[NSString stringWithUTF8String:url]] : nil;
    if (!result && PyErr_Occurred()) PyErr_Print();
    Py_XDECREF(reply);
    Py_XDECREF(start);
    Py_XDECREF(module);
    PyEval_SaveThread();
    return result;
}

@interface UndertoneApp : UIResponder <UIApplicationDelegate, WKNavigationDelegate, WKUIDelegate>
@property (strong, nonatomic) UIWindow *window;
@property (strong, nonatomic) NSURL *startURL;
@property (assign, nonatomic) UIBackgroundTaskIdentifier backgroundTask;
@end

@implementation UndertoneApp
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.backgroundTask = UIBackgroundTaskInvalid;
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    UIViewController *controller = [UIViewController new];
    controller.view.backgroundColor = [UIColor colorWithRed:.067 green:.078 blue:.075 alpha:1];
    self.window.rootViewController = controller;
    [self.window makeKeyAndVisible];
    [AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryPlayback error:nil];
    self.startURL = startEngine();
    if (!self.startURL) {
        UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Undertone" message:@"The music engine could not start." preferredStyle:UIAlertControllerStyleAlert];
        [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
        [controller presentViewController:alert animated:YES completion:nil];
        return YES;
    }
    WKWebViewConfiguration *settings = [WKWebViewConfiguration new];
    settings.allowsInlineMediaPlayback = YES;
    settings.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    [settings.userContentController addUserScript:[[WKUserScript alloc] initWithSource:@"window.UndertoneIOS = true;"
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    WKWebView *view = [[WKWebView alloc] initWithFrame:CGRectZero configuration:settings];
    view.navigationDelegate = self;
    view.UIDelegate = self;
    view.opaque = NO;
    view.backgroundColor = controller.view.backgroundColor;
    view.translatesAutoresizingMaskIntoConstraints = NO;
    [controller.view addSubview:view];
    UILayoutGuide *bounds = controller.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [view.topAnchor constraintEqualToAnchor:bounds.topAnchor], [view.bottomAnchor constraintEqualToAnchor:bounds.bottomAnchor],
        [view.leadingAnchor constraintEqualToAnchor:bounds.leadingAnchor], [view.trailingAnchor constraintEqualToAnchor:bounds.trailingAnchor],
    ]];
    [view loadRequest:[NSURLRequest requestWithURL:self.startURL]];
    return YES;
}

- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decide {
    NSURL *url = action.request.URL;
    NSString *path = [self.startURL.path stringByDeletingLastPathComponent];
    if ([url.scheme isEqual:@"http"] && [url.host isEqual:self.startURL.host] && [url.port isEqual:self.startURL.port]
        && [url.path hasPrefix:[path stringByAppendingString:@"/"]]) {
        decide(WKNavigationActionPolicyAllow);
    } else {
        if (action.navigationType == WKNavigationTypeLinkActivated && [url.scheme isEqual:@"https"]) {
            [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
        }
        decide(WKNavigationActionPolicyCancel);
    }
}

- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    [self checkLaunch:view attempts:30];
}

- (void)checkLaunch:(WKWebView *)view attempts:(NSInteger)attempts {
    [view evaluateJavaScript:@"!!document.querySelector('.home-heading') && typeof crypto.randomUUID === 'function'"
        completionHandler:^(id ready, NSError *error) {
        if ([ready boolValue]) NSLog(@"Undertone iOS UI ready");
        else if (attempts > 0) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), dispatch_get_main_queue(), ^{
            [self checkLaunch:view attempts:attempts - 1];
        });
    }];
}

- (void)applicationDidEnterBackground:(UIApplication *)app {
    self.backgroundTask = [app beginBackgroundTaskWithName:@"Undertone library jobs" expirationHandler:^{
        [self endBackgroundWork:app];
    }];
}

- (void)applicationWillEnterForeground:(UIApplication *)app {
    [self endBackgroundWork:app];
}

- (void)endBackgroundWork:(UIApplication *)app {
    if (self.backgroundTask != UIBackgroundTaskInvalid) {
        [app endBackgroundTask:self.backgroundTask];
        self.backgroundTask = UIBackgroundTaskInvalid;
    }
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(UndertoneApp.class));
    }
}
