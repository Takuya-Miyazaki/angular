import {Component, NgModule} from '@angular/core';

@Component({
    selector: 'my-component', template: `<div [class.color]></div>`,
    standalone: false
})
export class MyComponent {
}

@NgModule({declarations: [MyComponent]})
export class MyModule {
}